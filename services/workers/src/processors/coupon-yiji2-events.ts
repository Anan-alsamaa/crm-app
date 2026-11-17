import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItem, readItems, updateItem } from '@directus/sdk';
import type { Yiji2CouponEventJob } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';
import { couponLockKey, COUPON_PUSH_LOCK_MS, type CouponPushLock } from './coupon-push.js';

/**
 * YIJI V2 COUPON / CUSTOMER EVENTS (contract agreed with the v2 team and the
 * owner, 17 Nov 2026). Yiji v2 only - v1 sends no such events and nothing
 * here touches a v1 row.
 *
 * A coupon approved for a phone with no v2 account is created on v2 WITH the
 * phone; v2 holds a PENDING grant and assigns it itself when the number signs
 * up, in the account's own transaction, then sends:
 *
 *   - `coupon.granted` (`pending_grant_id` + the new `grant_id`): the row is
 *     found by its stored pending grant id (else the v2 coupon id, else code +
 *     phone), and completed exactly as a delivered coupon is - `assigned`,
 *     `yiji_coupon_user_id` = the grant id (the receipt), error cleared. With
 *     the receipt the row leaves the signup watch for good: the sweep's held
 *     read and the push both stop on `yiji_coupon_user_id`. `awaiting_signup_at`
 *     stays as history, as it does for every coupon delivered after a wait.
 *   - `customer.created`: logged, and the rows still waiting on a v2 pending
 *     grant for that phone are re-checked at once (a push job each; the push
 *     reads the wallet first and never creates a second coupon). No Yiji call
 *     is made here.
 *
 * Never a second grant, never a create: this job only WRITES the CRM row.
 */
export type Yiji2CouponEventOutcome =
  | 'assigned'
  | 'already-assigned'
  | 'not-found'
  | 'ambiguous'
  | 'conflict'
  | 'not-approved'
  | 'not-v2'
  | 'customer-noted';

export interface Yiji2CouponEventDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  /** The coupons queue, for the immediate re-check on `customer.created`. */
  couponsQueue?: Pick<Queue, 'add'>;
  /** One change per coupon at a time (the push's lock). */
  lock?: CouponPushLock;
  /** The platform of a row's vendor (`yiji2` required); absent = not checked (tests). */
  platformOf?: (couponApprovalId: string) => Promise<string | null>;
}

interface Candidate {
  id: string;
  status?: string | null;
  coupon_code?: string | null;
  customer_phone?: string | null;
  contact?: { phone?: string | null } | null;
  yiji_coupon_user_id?: string | number | null;
  yiji_coupon_id?: string | number | null;
}

const FIELDS = [
  'id',
  'status',
  'coupon_code',
  'customer_phone',
  { contact: ['phone'] },
  'yiji_coupon_user_id',
  'yiji_coupon_id',
];

/** The same handset whatever the spelling (`05…`, `+9665…`, `9665…`): the last 9 digits. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = String(a ?? '').replace(/\D/g, '');
  const db = String(b ?? '').replace(/\D/g, '');
  if (da.length < 8 || db.length < 8) return false;
  const n = Math.min(9, da.length, db.length);
  return da.slice(-n) === db.slice(-n);
}

const rowPhone = (r: Candidate) => r.customer_phone || r.contact?.phone || null;

async function find(
  deps: Yiji2CouponEventDeps,
  filter: Record<string, unknown>,
  what: string,
  limit = 5,
): Promise<Candidate[]> {
  try {
    const rows = (await deps.directus.request(
      readItems('coupon_approvals' as never, { filter, fields: FIELDS, limit } as never),
    )) as unknown as Candidate[];
    return rows ?? [];
  } catch (err) {
    /* A column not applied yet 403s the read: the next key is tried. */
    deps.logger.warn(
      { err: describeError(err), by: what },
      'yiji2 coupon.granted: could not look the coupon up this way - trying the next',
    );
    return [];
  }
}

async function findGrantedRow(
  job: Extract<Yiji2CouponEventJob, { type: 'coupon.granted' }>,
  deps: Yiji2CouponEventDeps,
): Promise<Candidate[]> {
  let rows = await find(
    deps,
    { yiji_pending_grant_id: { _eq: job.pendingGrantId } },
    'pending grant id',
  );
  if (rows.length === 0 && job.couponId) {
    rows = await find(deps, { yiji_coupon_id: { _eq: job.couponId } }, 'v2 coupon id');
  }
  if (rows.length === 0 && job.code) {
    rows = await find(deps, { coupon_code: { _eq: job.code } }, 'code');
    if (job.phone) rows = rows.filter((r) => samePhone(rowPhone(r), job.phone));
  }
  return rows;
}

export async function processYiji2CouponEvent(
  job: Yiji2CouponEventJob,
  deps: Yiji2CouponEventDeps,
): Promise<Yiji2CouponEventOutcome> {
  const { directus, logger } = deps;
  if (job.type === 'customer.created') return customerCreated(job, deps);

  const log = { eventId: job.eventId, pendingGrantId: job.pendingGrantId, grantId: job.grantId };
  const rows = await findGrantedRow(job, deps);
  if (rows.length === 0) {
    /* Settled: retrying cannot make the row appear. Logged for a human. */
    logger.warn(log, 'yiji2 coupon.granted: no CRM coupon matches this pending grant - ignored');
    return 'not-found';
  }
  if (rows.length > 1) {
    logger.error(
      { ...log, ids: rows.map((r) => r.id) },
      'yiji2 coupon.granted: more than one CRM coupon matches - none changed',
    );
    return 'ambiguous';
  }
  const id = rows[0]!.id;
  if (deps.platformOf) {
    const platform = await deps.platformOf(id);
    if (platform !== 'yiji2') {
      logger.error(
        { ...log, id, platform },
        'yiji2 coupon.granted matched a coupon that is not a Yiji v2 coupon - not changed',
      );
      return 'not-v2';
    }
  }

  const key = couponLockKey(id);
  if (deps.lock && !(await deps.lock.acquire(key, COUPON_PUSH_LOCK_MS))) {
    /* A push of this coupon is running: BullMQ retries this job shortly. */
    throw new Error('another change to this coupon is running');
  }
  try {
    /* Re-read inside the lock: a push may have just written the receipt. */
    const row = (await directus.request(
      readItem('coupon_approvals' as never, id, { fields: FIELDS } as never),
    )) as unknown as Candidate;
    const held = row?.yiji_coupon_user_id != null ? String(row.yiji_coupon_user_id).trim() : '';
    if (held === job.grantId) {
      logger.info({ ...log, id }, 'yiji2 coupon.granted: already recorded - nothing to do');
      return 'already-assigned';
    }
    if (held) {
      logger.error(
        { ...log, id, recorded: held },
        'yiji2 coupon.granted: the coupon already carries a DIFFERENT grant - not changed',
      );
      return 'conflict';
    }
    if (row?.status !== 'approved' && row?.status !== 'edited') {
      logger.warn(
        { ...log, id, status: row?.status },
        'yiji2 coupon.granted: v2 assigned a coupon the CRM no longer holds as approved - not changed',
      );
      return 'not-approved';
    }
    await directus.request(
      updateItem('coupon_approvals' as never, id, {
        status: 'assigned',
        yiji_coupon_user_id: job.grantId,
        ...(job.couponId && !row?.yiji_coupon_id ? { yiji_coupon_id: job.couponId } : {}),
        yiji_pushed_at: job.at,
        yiji_push_error: null,
      } as never),
    );
    logger.info(
      { ...log, id, code: row.coupon_code },
      'yiji2 coupon.granted: the customer signed up and v2 assigned the coupon - marked assigned',
    );
    return 'assigned';
  } finally {
    if (deps.lock) await deps.lock.release(key).catch(() => undefined);
  }
}

async function customerCreated(
  job: Extract<Yiji2CouponEventJob, { type: 'customer.created' }>,
  deps: Yiji2CouponEventDeps,
): Promise<Yiji2CouponEventOutcome> {
  const { logger } = deps;
  logger.info(
    { eventId: job.eventId, customerId: job.customerId, country: job.country },
    'yiji2 customer.created',
  );
  if (!deps.couponsQueue) return 'customer-noted';
  /* Only rows waiting on a v2 PENDING grant (the column is v2's alone), so a
     v2 sign-up never makes a v1 coupon look its number up. */
  const waiting = await find(
    deps,
    {
      status: { _in: ['approved', 'edited'] },
      awaiting_signup_at: { _nnull: true },
      yiji_coupon_user_id: { _null: true },
      yiji_push_error: { _null: true },
      yiji_pending_grant_id: { _nnull: true },
    },
    'waiting for this phone',
    -1,
  );
  let queued = 0;
  for (const r of waiting.filter((w) => samePhone(rowPhone(w), job.phone))) {
    try {
      await deps.couponsQueue.add(
        'push',
        { couponApprovalId: r.id },
        { removeOnComplete: true, removeOnFail: true },
      );
      queued++;
    } catch (err) {
      logger.warn(
        { id: r.id, err: describeError(err) },
        'yiji2 customer.created: could not queue the re-check - the sweep will look',
      );
    }
  }
  if (queued) logger.info({ eventId: job.eventId, queued }, 'yiji2 customer.created: re-checked');
  return 'customer-noted';
}
