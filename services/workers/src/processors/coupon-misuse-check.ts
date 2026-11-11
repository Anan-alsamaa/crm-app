import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, readUsers, updateItem } from '@directus/sdk';
import { envKey } from '@yiji/shared-config/redis';
import type { YijiDirectusClient } from '@yiji/shared-config';
import {
  errorText,
  type NotificationJob,
  type YijiCouponOrder,
  type YijiCouponRecord,
} from '@yiji/shared-types';

/**
 * COUPON MISUSE CHECK (owner, 2026-11-02).
 *
 * October 2026: CRM compensation coupons created as General (29 Sep - 5 Oct)
 * were shared and redeemed by hundreds of other customers, and nobody knew for
 * a month. This check tells the Administrator, in the app, the same day:
 *
 *   1. MISUSE - an order paid with a CRM coupon by someone other than the
 *      customer it was given to (another copy of the code, another phone);
 *   2. NOT PRIVATE - a CRM coupon created in the last few days that Yiji holds
 *      as anything but Private (anyone with a General code can add it).
 *
 * Read-only, with the CRM's OWN Yiji account: the holder list and the coupon
 * reports are closed to it (403 / "No report found", 2026-11-02), but the
 * order list says which coupon each order used (`couponReferenceId`) and a
 * coupon can be read by id. Load: a day is ~1,000 orders = 2-3 pages; two days
 * a run, plus one read per coupon id never seen before (cached in Redis).
 *
 * Each finding is alerted ONCE (a Redis key per finding), so a run every few
 * hours does not repeat itself.
 */

export const COUPON_MISUSE_CHECK_JOB = 'coupon_misuse_check';
const SCHEDULER = 'coupon-misuse-check';
export const DEFAULT_COUPON_MISUSE_CHECK_MS = 3 * 60 * 60_000;
/** New coupon ids resolved per run - a cap, so a first run cannot burst. */
const MAX_COUPON_READS = 60;
/** How far back the Private check looks at newly created coupons. */
const TYPE_CHECK_DAYS = 3;
const CODE_CACHE_SEC = 60 * 24 * 60 * 60;
const FINDING_TTL_SEC = 14 * 24 * 60 * 60;
const LINK = '/coupon-approvals';
/** Who is told: the owner tier (memory: notification-recipients-trap - by role NAME). */
const ALERT_ROLES = ['Administrator'] as const;
/** Yiji's coupon type: 1 = Private. Every CRM coupon is Private. */
const YIJI_PRIVATE = 1;

export interface CrmCouponRow {
  id: string;
  coupon_code: string | null;
  title?: string | null;
  customer_phone?: string | null;
  contact?: { phone?: string | null } | null;
  yiji_coupon_user_id?: string | number | null;
  yiji_coupon_id?: string | number | null;
  yiji_pushed_at?: string | null;
  /** Stamped when Yiji shows the coupon used (2026-11-11). */
  yiji_used_order?: string | null;
}

export interface MisuseFinding {
  kind: 'misuse' | 'not_private';
  code: string;
  /** The order(s) or coupon id that proves it. */
  detail: string;
  /** Unique per finding, for the once-only alert. */
  key: string;
}

/** `+966 50 123 4567`, `0501234567`, `501234567` -> `501234567`. */
export function nationalPhone(p: string | null | undefined): string {
  return String(p ?? '')
    .replace(/\D/g, '')
    .replace(/^00/, '')
    .replace(/^966/, '')
    .replace(/^0+/, '');
}

/** Yiji's local day (Riyadh, UTC+3) for a moment, `YYYY-MM-DD`. */
export function riyadhDay(at: Date): string {
  return new Date(at.getTime() + 3 * 60 * 60_000).toISOString().slice(0, 10);
}

/**
 * Pure: the misused orders among `orders`. A coupon order is misuse when the
 * coupon is a CRM coupon (known by grant, by Yiji id, or by its resolved
 * code), the copy used is NOT the one the CRM gave, and the phone is not the
 * intended customer's.
 */
export function findMisuse(
  orders: YijiCouponOrder[],
  rows: CrmCouponRow[],
  codeById: ReadonlyMap<number, string>,
): MisuseFinding[] {
  const byGrant = new Map<string, CrmCouponRow>();
  const byCode = new Map<string, CrmCouponRow>();
  const byYijiId = new Map<number, CrmCouponRow>();
  for (const r of rows) {
    if (r.yiji_coupon_user_id != null) byGrant.set(String(r.yiji_coupon_user_id), r);
    if (r.coupon_code) byCode.set(r.coupon_code, r);
    if (r.yiji_coupon_id != null && Number(r.yiji_coupon_id) > 0)
      byYijiId.set(Number(r.yiji_coupon_id), r);
  }
  const out = new Map<string, { code: string; orders: string[] }>();
  for (const o of orders) {
    if (byGrant.has(o.couponGrantId)) continue; // the copy the CRM gave
    const code = codeById.get(o.couponId);
    const row = byYijiId.get(o.couponId) ?? (code ? byCode.get(code) : undefined);
    if (!row?.coupon_code) continue; // not a CRM coupon
    const intended = new Set(
      [row.title, row.customer_phone, row.contact?.phone].map(nationalPhone).filter(Boolean),
    );
    const phone = nationalPhone(o.phone);
    if (phone && intended.has(phone)) continue; // the same customer
    const f = out.get(row.coupon_code) ?? { code: row.coupon_code, orders: [] };
    f.orders.push(o.orderId);
    out.set(row.coupon_code, f);
  }
  return [...out.values()].flatMap((f) =>
    f.orders.map((orderId) => ({
      kind: 'misuse' as const,
      code: f.code,
      detail: `order ${orderId}`,
      key: `misuse:${f.code}:${orderId}`,
    })),
  );
}

/** Narrow Redis surface - tests need no server. */
export interface MisuseRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>;
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<unknown>;
}

export interface CouponMisuseDeps {
  directus: YijiDirectusClient;
  notificationsQueue: Pick<Queue, 'add'>;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Absent = no Yiji credential: the check does nothing. */
  readOrders?: ((day: string) => Promise<YijiCouponOrder[]>) | null;
  readCoupon?: ((id: number) => Promise<YijiCouponRecord | null>) | null;
  redis?: MisuseRedis;
  now?: () => Date;
  recipients?: () => Promise<string[]>;
}

export interface CouponMisuseResult {
  status: 'off' | 'failed' | 'clean' | 'alerted' | 'no-recipient' | 'already-alerted';
  orders: number;
  findings: number;
}

export async function runCouponMisuseCheck(deps: CouponMisuseDeps): Promise<CouponMisuseResult> {
  const { directus, logger, redis } = deps;
  if (!deps.readOrders || !deps.readCoupon) return { status: 'off', orders: 0, findings: 0 };
  const now = deps.now?.() ?? new Date();

  let rows: CrmCouponRow[];
  try {
    rows = (await directus.request(
      readItems(
        'coupon_approvals' as never,
        {
          filter: {
            _or: [{ yiji_coupon_user_id: { _nnull: true } }, { yiji_coupon_id: { _nnull: true } }],
          },
          fields: [
            'id',
            'coupon_code',
            'title',
            'customer_phone',
            { contact: ['phone'] },
            'yiji_coupon_user_id',
            'yiji_coupon_id',
            'yiji_pushed_at',
            'yiji_used_order',
          ],
          limit: -1,
        } as never,
      ),
    )) as unknown as CrmCouponRow[];
  } catch (err) {
    logger.warn({ err: errorText(err) }, 'coupon misuse check: CRM coupons could not be read');
    return { status: 'failed', orders: 0, findings: 0 };
  }
  if (!rows.length) return { status: 'clean', orders: 0, findings: 0 };

  /* Today and yesterday, Yiji's local days: a run just after midnight still
     sees the evening before. */
  const days = [riyadhDay(new Date(now.getTime() - 24 * 60 * 60_000)), riyadhDay(now)];
  let orders: YijiCouponOrder[] = [];
  try {
    for (const d of days) orders = orders.concat(await deps.readOrders(d));
  } catch (err) {
    /* The next run is a few hours away; an outage is not a finding. */
    logger.warn({ err: errorText(err) }, 'coupon misuse check: Yiji orders could not be read');
    return { status: 'failed', orders: 0, findings: 0 };
  }

  /*
   * USED COUPONS ARE STAMPED (owner, 2026-11-11: "for a coupon already used by
   * the customer the edit button shouldn't exist"). The orders just read name
   * the grant each one spent; a CRM coupon seen here gets `yiji_used_order`, and
   * the ticket screen stops offering Edit. No extra Yiji call - this is the data
   * the check already has. The edit worker still asks Yiji itself before any
   * change, so a use newer than this run is caught too.
   */
  const crmByGrant = new Map(
    rows
      .filter((r) => r.yiji_coupon_user_id && !r.yiji_used_order)
      .map((r) => [String(r.yiji_coupon_user_id), r] as const),
  );
  let stamped = 0;
  for (const o of orders) {
    const r = crmByGrant.get(o.couponGrantId);
    if (!r) continue;
    try {
      await directus.request(
        updateItem('coupon_approvals' as never, r.id, {
          yiji_used_order: o.orderId,
          yiji_used_at: o.placedAt ? new Date(o.placedAt).toISOString() : now.toISOString(),
        } as never),
      );
      crmByGrant.delete(o.couponGrantId);
      stamped += 1;
    } catch (err) {
      logger.warn(
        { id: r.id, err: errorText(err) },
        'coupon misuse check: used coupon not stamped',
      );
    }
  }
  if (stamped) logger.info({ stamped }, 'coupon misuse check: used coupons stamped');

  /* Which coupon is each id? Known from the CRM's own records, then the Redis
     cache, then ONE read per new id (capped per run; the rest wait). */
  const grants = new Set(rows.map((r) => String(r.yiji_coupon_user_id ?? '')));
  const codeById = new Map<number, string>();
  for (const r of rows)
    if (r.coupon_code && Number(r.yiji_coupon_id) > 0)
      codeById.set(Number(r.yiji_coupon_id), r.coupon_code);
  const unknown = [
    ...new Set(
      orders
        .filter((o) => !grants.has(o.couponGrantId) && !codeById.has(o.couponId))
        .map((o) => o.couponId),
    ),
  ];
  let reads = 0;
  for (const id of unknown) {
    const cacheKey = envKey(`coupon-code:${id}`);
    const cached = redis ? await redis.get(cacheKey).catch(() => null) : null;
    if (cached != null) {
      if (cached) codeById.set(id, cached);
      continue;
    }
    if (reads >= MAX_COUPON_READS) continue;
    reads += 1;
    try {
      const c = await deps.readCoupon(id);
      const code = c?.code ?? '';
      if (code) codeById.set(id, code);
      await redis?.set(cacheKey, code, 'EX', CODE_CACHE_SEC).catch(() => undefined);
    } catch (err) {
      logger.warn({ id, err: errorText(err) }, 'coupon misuse check: a coupon could not be read');
    }
  }

  const findings = findMisuse(orders, rows, codeById);

  /* NOT PRIVATE: every CRM coupon created in the last few days whose Yiji id
     the CRM knows, read back. */
  const since = now.getTime() - TYPE_CHECK_DAYS * 24 * 60 * 60_000;
  for (const r of rows) {
    const yid = Number(r.yiji_coupon_id);
    if (!(yid > 0) || !r.coupon_code || !r.yiji_pushed_at) continue;
    if (!(Date.parse(r.yiji_pushed_at) >= since)) continue;
    try {
      const c = await deps.readCoupon(yid);
      if (c && c.type !== YIJI_PRIVATE) {
        findings.push({
          kind: 'not_private',
          code: r.coupon_code,
          detail: `Yiji coupon #${yid} has type ${c.type ?? 'unknown'} (General = anyone with the code can add it)`,
          key: `not-private:${yid}`,
        });
      }
    } catch (err) {
      logger.warn({ id: yid, err: errorText(err) }, 'coupon misuse check: type read failed');
    }
  }

  if (!findings.length) {
    logger.info({ orders: orders.length, days }, 'coupon misuse check: clean');
    return { status: 'clean', orders: orders.length, findings: 0 };
  }

  /* Once per finding. Without Redis every run would repeat - better than
     silence, so it still alerts. */
  const fresh: MisuseFinding[] = [];
  for (const f of findings) {
    if (!redis) {
      fresh.push(f);
      continue;
    }
    try {
      const ok = await redis.set(
        envKey(`coupon-misuse:${f.key}`),
        now.toISOString(),
        'EX',
        FINDING_TTL_SEC,
        'NX',
      );
      if (ok === 'OK') fresh.push(f);
    } catch {
      fresh.push(f);
    }
  }
  logger.warn(
    {
      findings: findings.length,
      fresh: fresh.length,
      codes: [...new Set(findings.map((f) => f.code))],
    },
    'coupon misuse check: findings',
  );
  if (!fresh.length)
    return { status: 'already-alerted', orders: orders.length, findings: findings.length };

  const misuse = fresh.filter((f) => f.kind === 'misuse');
  const notPrivate = fresh.filter((f) => f.kind === 'not_private');
  const lines: string[] = [];
  if (misuse.length) {
    const byCode = new Map<string, string[]>();
    for (const f of misuse) byCode.set(f.code, [...(byCode.get(f.code) ?? []), f.detail]);
    lines.push(
      `${misuse.length} order(s) used a CRM coupon given to a different customer: ` +
        [...byCode.entries()]
          .slice(0, 8)
          .map(([code, d]) => `${code} x${d.length} (${d.slice(0, 3).join(', ')})`)
          .join('; '),
    );
  }
  if (notPrivate.length) {
    lines.push(
      `Not Private on Yiji: ${notPrivate
        .slice(0, 8)
        .map((f) => `${f.code} - ${f.detail}`)
        .join('; ')}`,
    );
  }
  const title = misuse.length
    ? 'Coupon used by the wrong customer'
    : 'Coupon is not Private on Yiji';
  const body = `${lines.join('. ')}. Check the coupon on Yiji and remove other customers' copies.`;
  const told = await alertAdministrators(
    {
      directus,
      notificationsQueue: deps.notificationsQueue,
      logger,
      ...(deps.recipients ? { recipients: deps.recipients } : {}),
    },
    {
      title,
      body,
      codes: [...new Set(fresh.map((f) => f.code))],
      stamp: `${Math.floor(now.getTime() / 60_000)}`,
    },
  );
  if (told !== 'sent') return { status: told, orders: orders.length, findings: findings.length };
  return { status: 'alerted', orders: orders.length, findings: findings.length };
}

/**
 * Tell every active Administrator, in the app. Shared by the check above and
 * by the coupon push, which blocks a coupon Yiji did not save as Private.
 */
export async function alertAdministrators(
  deps: {
    directus: YijiDirectusClient;
    notificationsQueue: Pick<Queue, 'add'>;
    logger: Pick<Logger, 'warn'>;
    recipients?: () => Promise<string[]>;
  },
  alert: { title: string; body: string; codes: string[]; stamp: string },
): Promise<'sent' | 'failed' | 'no-recipient'> {
  let recipients: string[];
  try {
    recipients = deps.recipients
      ? await deps.recipients()
      : (
          (await deps.directus.request(
            readUsers({
              filter: { status: { _eq: 'active' }, role: { name: { _in: [...ALERT_ROLES] } } },
              fields: ['id'],
              limit: -1,
            } as never) as never,
          )) as unknown as Array<{ id: string }>
        ).map((u) => u.id);
  } catch (err) {
    deps.logger.warn({ err: errorText(err) }, 'coupon alert: recipients could not be read');
    return 'failed';
  }
  if (!recipients.length) {
    deps.logger.warn({}, 'coupon alert: nobody to tell - no active Administrator');
    return 'no-recipient';
  }
  await Promise.all(
    recipients.map((recipientId) =>
      deps.notificationsQueue.add(
        COUPON_MISUSE_CHECK_JOB,
        {
          recipientId,
          type: 'automation',
          title: alert.title,
          body: alert.body,
          link: LINK,
          payload: { kind: 'coupon_misuse', codes: alert.codes },
        } satisfies NotificationJob,
        { jobId: `coupon-alert-${alert.stamp}-${recipientId}` },
      ),
    ),
  );
  return 'sent';
}

/** One job scheduler, however many worker tasks. `0` removes it. */
export async function scheduleCouponMisuseCheck(queue: Queue, everyMs: number): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER,
    { every: everyMs },
    {
      name: COUPON_MISUSE_CHECK_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
