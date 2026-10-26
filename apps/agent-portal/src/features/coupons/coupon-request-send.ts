import { createItem, readItems } from '@directus/sdk';

/**
 * SENDING A COUPON REQUEST SO IT CANNOT BE LOST, AND CANNOT BE SENT TWICE
 * (owner, 2026-10-25: "this issue shouldn't repeat; permanent and logical fix").
 *
 * Shatha's ticket on 25 Oct was saved, and the coupon behind it never arrived:
 * prod Directus logged the ticket, a read of it, and then nothing — no
 * `POST /items/coupon_approvals` at all — before the form flipped the ticket
 * back to Not Compensated. The form's catch threw the error away, so nobody
 * could say what it was. Everything here exists so that cannot happen again:
 *
 *  - THE ID IS OURS. The row's uuid is made in the browser before the first
 *    attempt and sent with every attempt, so a retry after a lost answer finds
 *    the row it already wrote instead of writing a second coupon.
 *  - TRANSIENT FAILURES ARE RETRIED (network, 5xx, a lapsed token), with a
 *    short back-off; a clear REFUSAL (validation, permission) is not, because
 *    asking again cannot change the answer and only delays telling the agent.
 *  - THE REASON SURVIVES, in plain words, for the dialog, the ticket's history
 *    and the browser console.
 */

/** Waits between attempts: 3 attempts in all. */
export const COUPON_RETRY_DELAYS_MS = [500, 1500] as const;

/** The tag every console line from this path carries, to filter on in DevTools. */
export const COUPON_LOG_TAG = '[coupon-request]';

/**
 * What went wrong, as the agent needs to hear it. The dialog translates the
 * kind; `detail` is the server's own words (short, sanitised) when it had any.
 */
export type CouponFailureKind =
  | 'network'
  | 'server'
  | 'session'
  | 'permission'
  | 'invalid'
  | 'duplicate_code'
  | 'prepare'
  | 'unknown';

/** Kinds a retry can fix. Everything else is a refusal. */
const TRANSIENT: ReadonlySet<CouponFailureKind> = new Set([
  'network',
  'server',
  'session',
  'unknown',
]);

export class CouponRequestError extends Error {
  readonly kind: CouponFailureKind;
  readonly status: number | null;
  readonly detail: string | null;
  readonly attempts: number;
  /** The request's own id, so a Retry re-sends the SAME request. */
  readonly requestId: string;
  constructor(info: {
    kind: CouponFailureKind;
    status: number | null;
    detail: string | null;
    attempts: number;
    requestId: string;
  }) {
    super(couponFailureText(info.kind, info.status, info.detail));
    this.name = 'CouponRequestError';
    this.kind = info.kind;
    this.status = info.status;
    this.detail = info.detail;
    this.attempts = info.attempts;
    this.requestId = info.requestId;
  }
  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }
}

/** English, for the ticket history and the console (the dialog translates). */
const KIND_TEXT: Record<CouponFailureKind, string> = {
  network: 'no connection to the server',
  server: 'the server did not answer',
  session: 'the session had expired',
  permission: 'permission refused',
  invalid: 'the server refused the coupon details',
  duplicate_code: 'that coupon code is already used',
  prepare: 'the coupon details could not be prepared',
  unknown: 'unexpected error',
};

export function couponFailureText(
  kind: CouponFailureKind,
  status: number | null,
  detail: string | null,
): string {
  const head = `${KIND_TEXT[kind]}${status ? ` (HTTP ${status})` : ''}`;
  return detail ? `${head}: ${detail}` : head;
}

/** Short and safe to store: no markup, no line breaks, capped. */
export function sanitiseDetail(raw: unknown, max = 180): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A uuid for the new row. `crypto.randomUUID` needs a secure context, which
 * prod (https) and localhost have; a plain-http dev host falls back to the
 * same v4 layout from `getRandomValues`.
 */
export function newCouponRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface ClassifiedError {
  kind: CouponFailureKind | 'duplicate_id';
  status: number | null;
  detail: string | null;
}

/**
 * Sort a failure into what it means.
 *
 * The Directus SDK (17.x) rejects with a plain `{ errors, response }` object,
 * not an Error — `errors` is the parsed JSON list, or the TEXT of an HTML/plain
 * body (a CloudFront or load-balancer error page). A rejected `fetch` (no
 * connection, a dropped socket, a CORS refusal) is a bare TypeError with no
 * response at all.
 */
export function classifyCouponError(err: unknown): ClassifiedError {
  if (err instanceof CouponRequestError) {
    return { kind: err.kind, status: err.status, detail: err.detail };
  }
  const e = (err ?? {}) as {
    response?: { status?: number };
    errors?: unknown;
    message?: unknown;
  };
  const status = typeof e.response?.status === 'number' ? e.response.status : null;
  const first = Array.isArray(e.errors)
    ? (e.errors[0] as
        | { message?: string; extensions?: { code?: string; field?: string | null } }
        | undefined)
    : undefined;
  const code = first?.extensions?.code;
  const detail = sanitiseDetail(
    first?.message ?? (typeof e.errors === 'string' ? e.errors : null) ?? e.message ?? null,
  );

  if (code === 'RECORD_NOT_UNIQUE') {
    /* OUR id already exists: an earlier attempt landed and its answer was
       lost. Anything else not unique is a real clash (a coupon code). */
    return first?.extensions?.field === 'id' || !first?.extensions?.field
      ? { kind: 'duplicate_id', status, detail }
      : { kind: 'duplicate_code', status, detail };
  }
  if (status === null) {
    return { kind: err instanceof TypeError ? 'network' : 'unknown', status, detail };
  }
  if (status >= 500 || status === 408 || status === 429) return { kind: 'server', status, detail };
  if (status === 401) return { kind: 'session', status, detail };
  if (status === 403 || code === 'FORBIDDEN') return { kind: 'permission', status, detail };
  if (status >= 400) return { kind: 'invalid', status, detail };
  return { kind: 'unknown', status, detail };
}

type DirectusLike = { request: (cmd: never) => Promise<unknown> };

export interface SendOptions {
  /** Waits between attempts; its length + 1 is the number of attempts. */
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called after every failed attempt (for the console). */
  onAttemptFailed?: (attempt: number, c: ClassifiedError, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Does the row with this id exist? `null` when it could not be told. */
async function rowExists(client: DirectusLike, id: string): Promise<boolean | null> {
  try {
    const rows = (await client.request(
      readItems(
        'coupon_approvals' as never,
        { filter: { id: { _eq: id } }, fields: ['id'], limit: 1 } as never,
      ) as never,
    )) as Array<{ id: string }> | null;
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return null;
  }
}

/**
 * Create the coupon request with a client-made id, retrying what a retry can
 * fix. Resolves with the created row (or `{ id }` when it was found already
 * written); rejects with a `CouponRequestError` naming the reason.
 */
export async function createCouponRequestIdempotent(
  client: DirectusLike,
  id: string,
  body: Record<string, unknown>,
  opts: SendOptions = {},
): Promise<unknown> {
  const delays = opts.delays ?? COUPON_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const item = { ...body, id };

  /* Serialise ONCE, up front. Something unserialisable in the payload would
     otherwise throw inside the SDK, before any request, with nothing to show
     for it — exactly the shape of the 25 Oct failure. */
  try {
    JSON.stringify(item);
  } catch (err) {
    throw new CouponRequestError({
      kind: 'prepare',
      status: null,
      detail: sanitiseDetail((err as Error)?.message),
      attempts: 0,
      requestId: id,
    });
  }

  const attempts = delays.length + 1;
  let last: ClassifiedError = { kind: 'unknown', status: null, detail: null };
  let tried = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    tried = attempt;
    try {
      return await client.request(createItem('coupon_approvals' as never, item as never) as never);
    } catch (err) {
      const c = classifyCouponError(err);
      opts.onAttemptFailed?.(attempt, c, err);
      if (c.kind === 'duplicate_id') {
        /* Only success if the row really is there. */
        if ((await rowExists(client, id)) !== false) return { id };
        last = { kind: 'invalid', status: c.status, detail: c.detail };
        break;
      }
      last = c;
      if (!TRANSIENT.has(c.kind)) break;
      /* The write may have landed and only the answer been lost. */
      if (await rowExists(client, id)) return { id };
      if (attempt < attempts) await sleep(delays[attempt - 1] ?? 0);
    }
  }
  throw new CouponRequestError({
    kind: last.kind === 'duplicate_id' ? 'invalid' : last.kind,
    status: last.status,
    detail: last.detail,
    attempts: tried,
    requestId: id,
  });
}

/**
 * Retry a small follow-up write (the ticket's Compensation flag) on transient
 * failures only. Rejects with the last error.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: Pick<SendOptions, 'delays' | 'sleep'> = {},
): Promise<T> {
  const delays = opts.delays ?? COUPON_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const c = classifyCouponError(err);
      const retryable = c.kind !== 'duplicate_id' && TRANSIENT.has(c.kind);
      if (!retryable || attempt > delays.length) throw err;
      await sleep(delays[attempt - 1] ?? 0);
    }
  }
}
