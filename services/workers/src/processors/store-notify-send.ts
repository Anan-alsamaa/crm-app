import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, updateItem } from '@directus/sdk';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';

/**
 * BRANCH NOTIFICATIONS, DELIVERED TO SARAPOS (owner, 2026-10-29).
 *
 * `store_notifications` is the outbox the agent portal writes when a ticket's
 * complaint type is one operations chose (Branch notifications). Nothing sent
 * it until now. This job, every minute, takes at most `batch` QUEUED rows and
 * posts each to SaraPOS `order/complain-order`, addressed to the branch's own
 * SaraPOS outlet (`stores.sarapos_outlet_id` - NOT the Yiji restaurant id).
 *
 * What the branch receives is what the outbox holds and nothing more: the
 * complaint type, the order number and its items, what went wrong, and what
 * was done about it. Never the customer's name or phone, never the coupon.
 *
 * Bounded and switchable:
 *  - OFF unless the three SARAPOS_* settings are present (`sarapos.fromEnv`);
 *  - `0` for STORE_NOTIFY_SEND_MS removes the scheduler;
 *  - only rows younger than `maxAgeHours` are picked, so switching it on
 *    somewhere with an old backlog never floods branches with stale
 *    complaints - those stay `queued`, visibly unsent;
 *  - a refusal of OUR credentials (401/403) stops the run: every other row
 *    would be refused the same way.
 *
 * Staging: `SARAPOS_REDIRECT_OUTLET_ID` sends every message to one test outlet
 * (LCP LAB), the way staging coupons go to the owner's phone. Refused at start
 * on a worker pointed at production.
 */

export const STORE_NOTIFY_SEND_JOB = 'store_notify_send';
const SCHEDULER = 'store-notify-send';
export const DEFAULT_STORE_NOTIFY_SEND_MS = 60_000;
/** Most SaraPOS posts one run makes. */
export const STORE_NOTIFY_SEND_BATCH = 20;
/** A row that failed this many times is marked `failed` and left alone. */
export const STORE_NOTIFY_MAX_ATTEMPTS = 5;
/** Rows older than this are never sent automatically. */
export const STORE_NOTIFY_MAX_AGE_HOURS = 24;

export interface SaraposConfig {
  /** e.g. https://sarapos.com/onlineorderapi/webservice/online-order */
  baseUrl: string;
  bearerToken: string;
  secretKey: string;
  /** Staging only: every message goes to this outlet instead of the branch's. */
  redirectOutletId?: string;
  timeoutMs?: number;
}

/**
 * The SaraPOS settings, or null when any is missing (= the sender is off).
 * Throws when a redirect is set on a worker pointed at production: that would
 * send every branch's complaints to one test outlet while reporting success.
 */
export function saraposConfigFromEnv(env: NodeJS.ProcessEnv): SaraposConfig | null {
  const baseUrl = (env.SARAPOS_API_URL ?? '').trim().replace(/\/+$/, '');
  const bearerToken = (env.SARAPOS_BEARER_TOKEN ?? '').trim();
  const secretKey = (env.SARAPOS_SECRET_KEY ?? '').trim();
  const redirect = (env.SARAPOS_REDIRECT_OUTLET_ID ?? '').trim();
  if (redirect) {
    const directus = (env.DIRECTUS_INTERNAL_URL ?? '').toLowerCase();
    if (directus.includes('prod-directus') || directus.includes('crm-api.anan.sa')) {
      throw new Error(
        'SARAPOS_REDIRECT_OUTLET_ID is set on a worker pointed at PRODUCTION Directus. ' +
          "That would send every branch's complaints to one test outlet. Unset it.",
      );
    }
  }
  if (!baseUrl || !bearerToken || !secretKey) return null;
  return { baseUrl, bearerToken, secretKey, ...(redirect ? { redirectOutletId: redirect } : {}) };
}

interface OutboxRow {
  id: string;
  complaint_type?: string | null;
  description?: string | null;
  resolution_notes?: string | null;
  order_id?: string | null;
  order_items?: Array<{ name?: string | null; qty?: number | null }> | null;
  attempts?: number | null;
  store?: { name?: string | null; code?: string | null; sarapos_outlet_id?: string | null } | null;
}

const FIELDS = [
  'id',
  'complaint_type',
  'description',
  'resolution_notes',
  'order_id',
  'order_items',
  'attempts',
  { store: ['name', 'code', 'sarapos_outlet_id'] },
];

/** SaraPOS's two text fields, built from the outbox row. */
export function complaintMessage(row: OutboxRow): {
  message_heading: string;
  customer_message: string;
} {
  const type = row.complaint_type?.trim() || 'Customer complaint';
  const order = row.order_id?.trim();
  const items = (row.order_items ?? [])
    .filter((i) => i?.name)
    .map((i) => `${i.qty && i.qty > 1 ? `${i.qty}x ` : ''}${String(i.name).trim()}`);
  const lines = [
    order ? `Order: ${order}` : null,
    items.length ? `Items: ${items.join(', ')}` : null,
    row.description?.trim() ? `Complaint: ${row.description.trim()}` : null,
    row.resolution_notes?.trim() ? `Action taken: ${row.resolution_notes.trim()}` : null,
  ].filter((l): l is string => !!l);
  return {
    message_heading: order ? `${type} - Order ${order}` : type,
    customer_message: lines.length ? lines.join('\n') : type,
  };
}

export type SaraposFetch = (url: string, init: RequestInit) => Promise<Response>;

/** SaraPOS's reply envelope: `{ status, success, message, statuscode, response }`. */
interface SaraposReply {
  success?: unknown;
  message?: unknown;
}

export interface StoreNotifySendDeps {
  directus: YijiDirectusClient;
  sarapos: SaraposConfig | null;
  logger: Pick<Logger, 'info' | 'warn'>;
  fetch?: SaraposFetch;
  now?: () => Date;
  batch?: number;
}

export interface StoreNotifySendResult {
  sent: number;
  /** Failed this time and will be tried again. */
  retrying: number;
  /** Marked `failed` for good (no outlet, or out of attempts). */
  failed: number;
  stopped?: 'off' | 'read-failed' | 'unauthorized' | 'write-failed';
}

/** Post one complaint. Resolves with null on success, the reason otherwise. */
async function post(
  cfg: SaraposConfig,
  outletId: string,
  body: ReturnType<typeof complaintMessage>,
  doFetch: SaraposFetch,
): Promise<{ error: string | null; status: number | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(`${cfg.baseUrl}/order/complain-order`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.bearerToken}`,
        Secret_key: cfg.secretKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ outlet_id: Number(outletId) || outletId, ...body }),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json: SaraposReply | null = null;
    try {
      json = text ? (JSON.parse(text) as SaraposReply) : null;
    } catch {
      /* a non-JSON reply is judged on its status alone */
    }
    /* SaraPOS answers 200 with success:1. A 200 that says otherwise is a refusal. */
    if (res.ok && (json?.success === undefined || Number(json.success) === 1)) {
      return { error: null, status: res.status };
    }
    const why = typeof json?.message === 'string' ? json.message : text.slice(0, 300);
    return { error: `SaraPOS ${res.status}: ${why || 'refused'}`, status: res.status };
  } catch (err) {
    return { error: `SaraPOS unreachable: ${describeError(err)}`, status: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function runStoreNotifySend(
  deps: StoreNotifySendDeps,
): Promise<StoreNotifySendResult> {
  const { directus, sarapos, logger } = deps;
  const result: StoreNotifySendResult = { sent: 0, retrying: 0, failed: 0 };
  if (!sarapos) return { ...result, stopped: 'off' };
  const now = deps.now?.() ?? new Date();
  const doFetch: SaraposFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const since = new Date(now.getTime() - STORE_NOTIFY_MAX_AGE_HOURS * 60 * 60_000).toISOString();

  let rows: OutboxRow[];
  try {
    rows = (await directus.request(
      readItems(
        'store_notifications' as never,
        {
          fields: FIELDS,
          filter: { _and: [{ status: { _eq: 'queued' } }, { date_created: { _gte: since } }] },
          sort: ['date_created'],
          limit: Math.max(0, deps.batch ?? STORE_NOTIFY_SEND_BATCH),
        } as never,
      ) as never,
    )) as unknown as OutboxRow[];
  } catch (err) {
    logger.warn(
      { err: describeError(err) },
      'branch notifications: could not read the outbox - are store_notifications.attempts and stores.sarapos_outlet_id applied, and readable by svc-workers?',
    );
    return { ...result, stopped: 'read-failed' };
  }

  const mark = async (id: string, patch: Record<string, unknown>): Promise<boolean> => {
    try {
      await directus.request(
        updateItem('store_notifications' as never, id, patch as never) as never,
      );
      return true;
    } catch (err) {
      logger.warn(
        { id, err: describeError(err) },
        'branch notifications: could not record the outcome',
      );
      return false;
    }
  };

  for (const row of rows ?? []) {
    const branchOutlet = row.store?.sarapos_outlet_id?.trim() || null;
    if (!branchOutlet) {
      /* Not retried: nothing changes until someone sets the store's SaraPOS ID. */
      if (!(await mark(row.id, { status: 'failed', error: 'This store has no SaraPOS ID.' }))) {
        return { ...result, stopped: 'write-failed' };
      }
      result.failed += 1;
      continue;
    }
    const outlet = sarapos.redirectOutletId ?? branchOutlet;
    const message = complaintMessage(row);
    if (sarapos.redirectOutletId) {
      message.customer_message += `\n\n[Staging test - real branch: ${row.store?.code ?? ''} ${row.store?.name ?? ''} (SaraPOS ${branchOutlet})]`;
    }
    const { error, status } = await post(sarapos, outlet, message, doFetch);
    const attempts = (row.attempts ?? 0) + 1;

    if (!error) {
      if (
        !(await mark(row.id, { status: 'sent', sent_at: now.toISOString(), error: null, attempts }))
      ) {
        return { ...result, stopped: 'write-failed' };
      }
      result.sent += 1;
      continue;
    }

    const giveUp = attempts >= STORE_NOTIFY_MAX_ATTEMPTS;
    if (!(await mark(row.id, { status: giveUp ? 'failed' : 'queued', error, attempts }))) {
      return { ...result, stopped: 'write-failed' };
    }
    if (giveUp) result.failed += 1;
    else result.retrying += 1;
    logger.warn({ id: row.id, outlet, attempts, error }, 'branch notifications: send failed');
    if (status === 401 || status === 403) {
      /* Our credentials were refused: every other row would be too. */
      return { ...result, stopped: 'unauthorized' };
    }
  }

  if (result.sent + result.retrying + result.failed > 0) {
    logger.info({ ...result }, 'branch notifications sent to SaraPOS');
  }
  return result;
}

/** One job scheduler, however many worker tasks. `0` removes it. */
export async function scheduleStoreNotifySend(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER,
    { every: everyMs },
    {
      name: STORE_NOTIFY_SEND_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
