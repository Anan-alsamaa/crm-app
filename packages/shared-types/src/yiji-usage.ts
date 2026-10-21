/**
 * EVERY CALL THE CRM MAKES TO YIJI, AND WHICH ACCOUNT MADE IT (owner, 2026-10-21).
 *
 * Two credentials can reach Yiji's admin API:
 *
 *   - the CRM's OWN account (`YIJI_ADMIN_EMAIL` / `YIJI_ADMIN_PASSWORD`, signed
 *     in through `POST /api/Account/login`) - the ONLY primary credential;
 *   - the owner's personal admin token (`YIJI_BACKUP_TOKEN`) - a BACKUP, used
 *     for one call only when the CRM account could not make it: its login was
 *     refused, it was refused (401 after a re-login, or 403), or it is not
 *     configured at all. A timeout or a network error is NOT a reason - the
 *     backup would fail the same way, and quietly spending the owner's
 *     credential on an outage would hide the outage.
 *
 * Which of the two answered, for what, and how it went is recorded per call in
 * `yiji_api_usage`, so "is the CRM still leaning on my token?" has an answer
 * on the Admin KPI page instead of in a log nobody reads.
 *
 * Pure: no Directus, no process.env. The services hand the recorder a writer.
 */

export type YijiUsageAccount = 'crm' | 'backup';
export type YijiUsageOutcome = 'ok' | 'refused' | 'error';
export type YijiUsageService = 'workers' | 'socket-gateway' | 'ai-gateway';

export const YIJI_USAGE_ACCOUNTS: readonly YijiUsageAccount[] = ['crm', 'backup'];
export const YIJI_USAGE_OUTCOMES: readonly YijiUsageOutcome[] = ['ok', 'refused', 'error'];
export const YIJI_USAGE_SERVICES: readonly YijiUsageService[] = [
  'workers',
  'socket-gateway',
  'ai-gateway',
];

/** How long a usage row is kept before the workers' retention job deletes it. */
export const YIJI_USAGE_RETENTION_DAYS = 90;

/** One HTTP exchange with Yiji, as the client saw it. */
export interface YijiUsageEvent {
  /** Short, stable name - see `yijiOperationFor`. */
  operation: string;
  account: YijiUsageAccount;
  outcome: YijiUsageOutcome;
  /** Null when no response arrived (timeout, network). */
  httpStatus: number | null;
  durationMs: number;
  /** Why the backup was used; null for every CRM-account call. */
  fallbackReason?: string | null;
  /** Short, redacted - never a token, a password or a phone number. */
  error?: string | null;
  /** The vendor's platform id, when the caller knows it. */
  vendor?: string | null;
}

/** Told about every Yiji call. Must not throw - but is guarded anyway. */
export type YijiUsageSink = (event: YijiUsageEvent) => void;

/** A `yiji_api_usage` row. `date_created` is Directus's. */
export interface YijiUsageRow {
  service: YijiUsageService;
  operation: string;
  account: YijiUsageAccount;
  outcome: YijiUsageOutcome;
  http_status: number | null;
  duration_ms: number;
  fallback_reason: string | null;
  error: string | null;
  vendor: string | null;
}

/*
 * THE OPERATION NAMES. Matched on the PATH, so a new endpoint is named in one
 * place and every service reports it the same way. Order matters: the more
 * specific path first (`GetActiveCouponByUser` contains `CouponByUser`).
 */
const OPERATIONS: Array<[RegExp, string]> = [
  [/\/api\/Account\/login\b/i, 'login'],
  [/\/RemoveUserCoupon\b/i, 'coupon.remove'],
  [/\/Get(Active)?CouponByUser\b/i, 'coupon.wallet'],
  [
    /\/(CreateCouponUserFromOrder|AddUserCoupon|AddCompensationCoupon|AddCouponToUserByCode)\b/i,
    'coupon.push',
  ],
  [/\/api\/Coupon\/AddCoupon\b/i, 'coupon.create'],
  [/\/GetfilteredCustomers\b/i, 'customer.lookup'],
  [/\/GetUserById\b/i, 'user.lookup'],
  [/\/NotificationData\/Send/i, 'push.notify'],
  [/\/GetFilteredOrders\b/i, 'order.late_poll'],
  [/\/GetOrderStatusHistories/i, 'order.history'],
  [/\/GetOrderCart\b/i, 'order.cart'],
  [/\/GetOrderByUser\b/i, 'order.by_user'],
  [/\/GetOrderAsync\b/i, 'order.lookup'],
];

/** `GET https://admin.../api/User/GetfilteredCustomers?PhoneNumber=5...` -> `customer.lookup`. */
export function yijiOperationFor(url: string): string {
  const path = String(url ?? '').split('?')[0] ?? '';
  for (const [re, name] of OPERATIONS) if (re.test(path)) return name;
  return 'other';
}

/**
 * 2xx and 404 are ANSWERS (404 is how Yiji says "nothing there"); any other
 * 4xx is Yiji refusing; 5xx and no response at all are errors.
 */
export function yijiUsageOutcome(status: number | null): YijiUsageOutcome {
  if (status === null) return 'error';
  if ((status >= 200 && status < 300) || status === 404) return 'ok';
  if (status >= 400 && status < 500) return 'refused';
  return 'error';
}

/** The two statuses that mean "this CREDENTIAL may not", and may send a call to the backup. */
export function isYijiAuthRefusal(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * An error message safe to store: no query strings (they carry phone numbers),
 * no bearer tokens, no e-mail addresses, no long digit runs (phones), short.
 * Ids stay readable - an order or grant id is what makes a row useful.
 */
export function redactUsageText(text: string | null | undefined, max = 200): string | null {
  if (text === null || text === undefined) return null;
  const clean = String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\?[A-Za-z0-9_.-]+=[^\s'")]*/g, '?[query]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d{9,}/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Report one call; a sink that throws is swallowed - accounting never breaks a call. */
export function reportYijiUsage(sink: YijiUsageSink | undefined, event: YijiUsageEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    /* Bookkeeping. The Yiji call it describes already happened. */
  }
}

/**
 * The backup token from a service's environment: `YIJI_BACKUP_TOKEN`, or the
 * name it had while only coupon removal used it (`YIJI_COUPON_REMOVE_TOKEN`),
 * so a task definition that still carries the old name keeps working. A pasted
 * `Bearer ` prefix is dropped. Undefined when neither is set.
 */
export function yijiBackupTokenFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of ['YIJI_BACKUP_TOKEN', 'YIJI_COUPON_REMOVE_TOKEN']) {
    const v = env[name]?.trim().replace(/^Bearer\s+/i, '');
    if (v) return v;
  }
  return undefined;
}

export function yijiUsageRow(service: YijiUsageService, e: YijiUsageEvent): YijiUsageRow {
  return {
    service,
    operation: String(e.operation || 'other').slice(0, 64),
    account: e.account === 'backup' ? 'backup' : 'crm',
    outcome: YIJI_USAGE_OUTCOMES.includes(e.outcome) ? e.outcome : 'error',
    http_status: typeof e.httpStatus === 'number' ? e.httpStatus : null,
    duration_ms: Math.max(0, Math.round(Number(e.durationMs) || 0)),
    fallback_reason: redactUsageText(e.fallbackReason ?? null),
    error: redactUsageText(e.error ?? null),
    vendor: e.vendor ? String(e.vendor).slice(0, 64) : null,
  };
}

export interface YijiUsageRecorderOptions {
  service: YijiUsageService;
  /** Writes one batch. May throw; the batch is then dropped and `onError` told. */
  write: (rows: YijiUsageRow[]) => Promise<void>;
  onError?: (err: unknown, droppedRows: number) => void;
  /** Longest a row waits before it is written. Default 5 s. */
  flushMs?: number;
  /** Rows per write; a full batch is written at once. Default 50. */
  batchSize?: number;
  /** Rows held at most; beyond it the OLDEST are dropped. Default 1000. */
  maxBuffer?: number;
}

export interface YijiUsageRecorder {
  /** The sink to give a Yiji client. Never throws, never waits. */
  readonly record: YijiUsageSink;
  /** Write everything buffered now (shutdown, tests). Never throws. */
  flush(): Promise<void>;
  /** Rows waiting to be written. */
  pending(): number;
  /** Stop the timer and write what is left. */
  stop(): Promise<void>;
}

/**
 * BUFFERED, BEST-EFFORT. A busy sweep makes dozens of Yiji calls in a second;
 * a Directus write per call, awaited in the call path, would double its
 * latency and make Yiji accounting a way for Directus to break Yiji work. So a
 * call only appends to memory; rows are written in batches every `flushMs` or
 * when a batch fills, a failed write is dropped (and reported), and the buffer
 * is bounded so a long Directus outage cannot grow the process without limit.
 */
export function createYijiUsageRecorder(opts: YijiUsageRecorderOptions): YijiUsageRecorder {
  const flushMs = opts.flushMs ?? 5_000;
  const batchSize = Math.max(1, opts.batchSize ?? 50);
  const maxBuffer = Math.max(batchSize, opts.maxBuffer ?? 1_000);
  const buffer: YijiUsageRow[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;

  const tell = (err: unknown, dropped: number) => {
    try {
      opts.onError?.(err, dropped);
    } catch {
      /* a logger that throws must not reach the caller either */
    }
  };

  const drain = async (): Promise<void> => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, batchSize);
      try {
        await opts.write(batch);
      } catch (err) {
        tell(err, batch.length);
      }
    }
  };

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    inflight ??= drain().finally(() => {
      inflight = null;
      /* A row that arrived as the last write settled still gets its timer. */
      if (buffer.length > 0) arm();
    });
    return inflight;
  };

  const arm = () => {
    if (timer || inflight) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const record: YijiUsageSink = (event) => {
    try {
      buffer.push(yijiUsageRow(opts.service, event));
      if (buffer.length > maxBuffer) {
        const dropped = buffer.length - maxBuffer;
        buffer.splice(0, dropped);
        tell(new Error('yiji usage buffer full'), dropped);
      }
      if (buffer.length >= batchSize) void flush();
      else arm();
    } catch (err) {
      tell(err, 1);
    }
  };

  return {
    record,
    flush: async () => {
      await flush();
      /* Rows recorded while a write was in flight. */
      if (buffer.length > 0) await flush();
    },
    pending: () => buffer.length,
    stop: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
      if (buffer.length > 0) await flush();
    },
  };
}

/**
 * A `fetch` that reports each call to `sink` - for the few places that call a
 * Yiji URL with their own fetch instead of through `HttpYijiClient` (the
 * customer push's direct path). Uses the global fetch AT CALL TIME unless one
 * is given, so a test's stub still applies.
 */
export function fetchWithYijiUsage(
  sink: YijiUsageSink | undefined,
  account: YijiUsageAccount = 'crm',
  doFetch?: typeof fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url);
    const started = Date.now();
    try {
      const res = await (doFetch ?? fetch)(input, init);
      reportYijiUsage(sink, {
        operation: yijiOperationFor(url),
        account,
        outcome: yijiUsageOutcome(res.status),
        httpStatus: res.status,
        durationMs: Date.now() - started,
        error: res.ok || res.status === 404 ? null : `HTTP ${res.status}`,
      });
      return res;
    } catch (err) {
      reportYijiUsage(sink, {
        operation: yijiOperationFor(url),
        account,
        outcome: 'error',
        httpStatus: null,
        durationMs: Date.now() - started,
        error: `network error: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
  }) as typeof fetch;
}
