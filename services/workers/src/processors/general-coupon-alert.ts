import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItem, readItems } from '@directus/sdk';
import { envKey } from '@yiji/shared-config/redis';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { errorText, isGeneralCouponType, isPercentageCategory } from '@yiji/shared-types';
import { alertAdministrators } from './coupon-misuse-check.js';
import { couponCustomerPhone } from './coupon-push.js';

/**
 * EVERY GENERAL COUPON RAISES AN ALERT (owner, 17 Nov 2026):
 * "any general coupon created even on purpose should raise an alert."
 *
 * A General coupon (Yiji type 0) can be added to ANY account by whoever knows
 * the code - the October 2026 leak. Until now only a coupon Yiji SAVED as
 * General against the CRM's Private (`alertNotPrivate`) and the 3-hourly
 * misuse check alerted. Now the Administrators are told whenever a General
 * coupon is made, deliberately or not, at each stage:
 *
 *   compensation coupons (`coupon_approvals`, coupon_type General/Public):
 *     requested - the row was created or changed to General (a sweep, below)
 *     approved  - the coupon push picked the approved row up
 *     created   - Yiji created it (assigned, order-less or withheld)
 *   marketing coupons (`marketing_coupons` with audience other than `list` -
 *   `marketingCouponPayload` sends those as type 0):
 *     approved  - the marketing sender picked the approved row up
 *     created   - Yiji created it
 *
 * SAME CHANNEL AND RECIPIENTS as `alertNotPrivate`: `alertAdministrators`,
 * i.e. the notifications queue (in-app + its other channels) to every ACTIVE
 * user on the Administrator role, resolved by role NAME (the recipients trap:
 * the built-in Administrator role carries no privilege list, so a privilege
 * lookup reaches nobody).
 *
 * ONCE PER COUPON PER STAGE: a Redis key per (source, id, stage), SET NX with
 * a long expiry, claimed BEFORE anything is read - so the push retried by the
 * delivery sweep every minute, or the request sweep re-reading the same row,
 * never repeats an alert and costs one Redis call. The notification job id is
 * the same key, a second guard. A send that fails releases the key so the
 * next pass retries. Without Redis the request sweep does not run at all
 * (it would repeat every pass); the push stages then rely on the job id.
 *
 * ALERT ONLY. Nothing here blocks, changes or delays a coupon: every call is
 * wrapped so a failure is logged and the coupon carries on as before.
 */

export type GeneralCouponStage = 'requested' | 'approved' | 'created';
export type GeneralCouponSource = 'compensation' | 'marketing';

/** What the alert names. */
export interface GeneralCouponFacts {
  source: GeneralCouponSource;
  id: string;
  code: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  /** `SAR 50` / `20% (max SAR 30)`. */
  value: string;
  phone: string | null;
  ticket: string | null;
  /** In-portal link for the bell; null = none in the admin portal. */
  link: string | null;
}

export interface GeneralAlertRedis {
  set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface GeneralCouponAlertDeps {
  directus: YijiDirectusClient;
  notificationsQueue: Pick<Queue, 'add'>;
  logger: Pick<Logger, 'info' | 'warn'>;
  redis?: GeneralAlertRedis;
  /** Tests: who is told. Default: every active Administrator. */
  recipients?: () => Promise<string[]>;
  now?: () => Date;
}

/** Long enough that a coupon is never alerted twice for the same stage. */
const DEDUPE_TTL_SEC = 180 * 24 * 60 * 60;
const COMPENSATION_LINK = '/coupon-approvals';

export const GENERAL_COUPON_REQUEST_ALERT_JOB = 'general_coupon_request_alert';
const SCHEDULER = 'general-coupon-request-alert';
export const DEFAULT_GENERAL_COUPON_REQUEST_ALERT_MS = 2 * 60_000;
/** How far back the request sweep looks: covers a worker that was down for a day. */
const REQUEST_LOOKBACK_MS = 24 * 60 * 60_000;
/** Rows read per sweep. */
const REQUEST_READ_LIMIT = 100;

export function generalCouponDedupeKey(
  source: GeneralCouponSource,
  id: string,
  stage: GeneralCouponStage,
): string {
  return `general-coupon-alert:${source}:${id}:${stage}`;
}

const STAGE_WORDS: Record<GeneralCouponStage, string> = {
  requested: 'requested',
  approved: 'approved',
  created: 'created on Yiji',
};

/** Title + body: code, who created / approved, value, phone, ticket, where. */
export function generalCouponAlertText(
  facts: GeneralCouponFacts,
  stage: GeneralCouponStage,
): { title: string; body: string } {
  const kind = facts.source === 'marketing' ? 'Marketing coupon' : 'General coupon';
  const code = facts.code?.trim() || '(no code)';
  const title = `${kind} ${STAGE_WORDS[stage]}: ${code} is General`;
  const parts = [
    `${code} is a GENERAL coupon - anyone who knows the code can use it.`,
    `Value: ${facts.value}.`,
    `Created by: ${facts.createdBy ?? 'unknown'}.`,
    `Approved by: ${facts.approvedBy ?? (stage === 'requested' ? 'not yet' : 'unknown')}.`,
    ...(facts.phone ? [`Customer phone: ${facts.phone}.`] : []),
    ...(facts.ticket ? [`Ticket: ${facts.ticket}.`] : []),
    facts.source === 'marketing'
      ? 'Open it in the Marketing portal (Coupons).'
      : 'Open it in Coupon approvals.',
    'If it should not be General, remove it.',
  ];
  return { title, body: parts.join(' ') };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export function couponValueText(row: {
  discount_category?: string | null;
  coupon_value?: number | string | null;
  coupon_percent?: number | string | null;
  max_discount?: number | string | null;
}): string {
  const cap = num(row.max_discount);
  if (isPercentageCategory(row.discount_category)) {
    const pct = num(row.coupon_percent);
    return `${pct ?? '?'}%${cap ? ` (max SAR ${cap})` : ''}`;
  }
  const v = num(row.coupon_value);
  return v !== null ? `SAR ${v}` : 'unknown';
}

interface UserRef {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

function personName(u: UserRef | string | null | undefined): string | null {
  if (!u) return null;
  if (typeof u === 'string') return u;
  const name = [u.first_name, u.last_name]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(' ');
  return name || u.email?.trim() || u.id || null;
}

const USER_FIELDS = ['id', 'first_name', 'last_name', 'email'];

/** The compensation row fields the alert reads. */
export const COMPENSATION_FACT_FIELDS = [
  'id',
  'coupon_code',
  'coupon_type',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  'customer_phone',
  'title',
  'order_id',
  { contact: ['phone'] },
  { ticket: ['id', 'subject', 'order_id'] },
  { requested_by: USER_FIELDS },
  { user_created: USER_FIELDS },
  { decided_by: USER_FIELDS },
];

export interface CompensationFactRow {
  id: string;
  coupon_code?: string | null;
  coupon_type?: string | null;
  discount_category?: string | null;
  coupon_value?: number | string | null;
  coupon_percent?: number | string | null;
  max_discount?: number | string | null;
  customer_phone?: string | null;
  title?: string | null;
  order_id?: string | null;
  contact?: { phone?: string | null } | null;
  ticket?:
    | { id?: string | null; subject?: string | null; order_id?: string | null }
    | string
    | null;
  requested_by?: UserRef | string | null;
  user_created?: UserRef | string | null;
  decided_by?: UserRef | string | null;
}

export function compensationFacts(row: CompensationFactRow): GeneralCouponFacts {
  const t = row.ticket;
  const ticket =
    t && typeof t === 'object'
      ? [
          t.id,
          t.subject?.trim() ? `"${t.subject.trim()}"` : null,
          t.order_id ? `order ${t.order_id}` : null,
        ]
          .filter(Boolean)
          .join(' ') || null
      : (t ?? (row.order_id ? `none (order ${row.order_id})` : null));
  return {
    source: 'compensation',
    id: row.id,
    code: row.coupon_code ?? null,
    createdBy: personName(row.requested_by) ?? personName(row.user_created),
    approvedBy: personName(row.decided_by),
    value: couponValueText(row),
    phone: couponCustomerPhone(row),
    ticket,
    link: COMPENSATION_LINK,
  };
}

export const MARKETING_FACT_FIELDS = [
  'id',
  'code',
  'audience',
  'discount_category',
  'coupon_value',
  'coupon_percent',
  'max_discount',
  { user_created: USER_FIELDS },
  { decided_by: USER_FIELDS },
];

export interface MarketingFactRow {
  id: string;
  code?: string | null;
  audience?: string | null;
  discount_category?: string | null;
  coupon_value?: number | string | null;
  coupon_percent?: number | string | null;
  max_discount?: number | string | null;
  user_created?: UserRef | string | null;
  decided_by?: UserRef | string | null;
}

/** A marketing coupon is General on Yiji unless it is a `list` coupon (`marketingCouponPayload`). */
export function isGeneralMarketingCoupon(row: { audience?: string | null }): boolean {
  return row.audience !== 'list';
}

export function marketingFacts(row: MarketingFactRow): GeneralCouponFacts {
  return {
    source: 'marketing',
    id: row.id,
    code: row.code ?? null,
    createdBy: personName(row.user_created),
    approvedBy: personName(row.decided_by),
    value: couponValueText(row),
    phone: null,
    ticket: null,
    /* No marketing page in the admin portal: the body says where it is. */
    link: null,
  };
}

/**
 * Alert once for (source, id, stage). `load` is called only after the stage
 * was claimed, so a repeat costs one Redis call and no Directus read. Never
 * throws.
 */
export async function alertGeneralCoupon(
  deps: GeneralCouponAlertDeps,
  ref: { source: GeneralCouponSource; id: string; stage: GeneralCouponStage },
  load: () => Promise<GeneralCouponFacts | null>,
): Promise<'sent' | 'already-alerted' | 'not-general' | 'failed' | 'no-recipient'> {
  const { logger } = deps;
  const key = generalCouponDedupeKey(ref.source, ref.id, ref.stage);
  let claimed = false;
  if (deps.redis) {
    try {
      const ok = await deps.redis.set(
        envKey(key),
        (deps.now?.() ?? new Date()).toISOString(),
        'EX',
        DEDUPE_TTL_SEC,
        'NX',
      );
      if (ok !== 'OK') return 'already-alerted';
      claimed = true;
    } catch (err) {
      /* Redis hiccup: alert anyway - the job id below still dedupes. */
      logger.warn({ key, err: errorText(err) }, 'general coupon alert: dedupe key unavailable');
    }
  }
  const release = async () => {
    if (claimed) await deps.redis?.del(envKey(key)).catch(() => undefined);
  };
  let facts: GeneralCouponFacts | null;
  try {
    facts = await load();
  } catch (err) {
    logger.warn({ ...ref, err: errorText(err) }, 'general coupon alert: coupon could not be read');
    await release();
    return 'failed';
  }
  if (!facts) {
    /* Not General after all (changed back): free the stage for a later change. */
    await release();
    return 'not-general';
  }
  const { title, body } = generalCouponAlertText(facts, ref.stage);
  let told: 'sent' | 'failed' | 'no-recipient';
  try {
    told = await alertAdministrators(
      {
        directus: deps.directus,
        notificationsQueue: deps.notificationsQueue,
        logger,
        ...(deps.recipients ? { recipients: deps.recipients } : {}),
      },
      {
        title,
        body,
        codes: facts.code ? [facts.code] : [],
        stamp: key.replace(/:/g, '-'),
        link: facts.link,
        payload: {
          kind: 'general_coupon',
          stage: ref.stage,
          source: ref.source,
          ...(ref.source === 'marketing'
            ? { marketingCouponId: ref.id }
            : { couponApprovalId: ref.id }),
        },
      },
    );
  } catch (err) {
    logger.warn({ ...ref, err: errorText(err) }, 'general coupon alert: could not be queued');
    told = 'failed';
  }
  if (told !== 'sent') {
    await release();
    return told;
  }
  logger.warn({ ...ref, code: facts.code }, 'General coupon - Administrators alerted');
  return 'sent';
}

/** A compensation coupon by id, for the push stages: null when it is not General. */
export function loadCompensationFacts(
  directus: YijiDirectusClient,
  id: string,
): () => Promise<GeneralCouponFacts | null> {
  return async () => {
    const row = (await directus.request(
      readItem('coupon_approvals' as never, id, { fields: COMPENSATION_FACT_FIELDS } as never),
    )) as unknown as CompensationFactRow | null;
    if (!row || !isGeneralCouponType(row.coupon_type)) return null;
    return compensationFacts(row);
  };
}

/** A marketing coupon by id: null when it is a `list` (Private) coupon. */
export function loadMarketingFacts(
  directus: YijiDirectusClient,
  id: string,
): () => Promise<GeneralCouponFacts | null> {
  return async () => {
    const row = (await directus.request(
      readItem('marketing_coupons' as never, id, { fields: MARKETING_FACT_FIELDS } as never),
    )) as unknown as MarketingFactRow | null;
    if (!row || !isGeneralMarketingCoupon(row)) return null;
    return marketingFacts(row);
  };
}

/**
 * THE REQUEST-TIME ALERT: a sweep of coupon_approvals rows created or changed
 * in the last day whose type is General/Public.
 *
 * Why a worker sweep and not the Directus hook (notify-on-change) that already
 * watches `coupon_approvals.items.create`: the owner asked for the SAME channel
 * and recipients as `alertNotPrivate` - the notifications queue and Redis
 * dedupe live in the workers, the hook is deps-free and writes rows directly;
 * a hook change also only goes live with a Directus restart, and a hook that
 * failed would sit in the agent's save. A sweep is read-only, off the agent's
 * path, and catches every writer (portal, gateway, inbound API) the same way.
 * Cost: one Directus read every 2 minutes; at most one alert per coupon.
 */
export async function runGeneralCouponRequestAlert(
  deps: GeneralCouponAlertDeps,
): Promise<{ status: 'no-redis' | 'failed' | 'ok'; general: number; sent: number }> {
  const { directus, logger } = deps;
  if (!deps.redis) {
    logger.warn({}, 'general coupon request alert: no Redis to dedupe with - not run');
    return { status: 'no-redis', general: 0, sent: 0 };
  }
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - REQUEST_LOOKBACK_MS).toISOString();
  let rows: CompensationFactRow[];
  try {
    rows = (await directus.request(
      readItems(
        'coupon_approvals' as never,
        {
          fields: COMPENSATION_FACT_FIELDS,
          filter: {
            _and: [
              {
                _or: [
                  { coupon_type: { _icontains: 'general' } },
                  { coupon_type: { _icontains: 'public' } },
                ],
              },
              { _or: [{ date_created: { _gte: since } }, { date_updated: { _gte: since } }] },
            ],
          },
          sort: ['-date_created'],
          limit: REQUEST_READ_LIMIT,
        } as never,
      ) as never,
    )) as unknown as CompensationFactRow[];
  } catch (err) {
    logger.warn({ err: errorText(err) }, 'general coupon request alert: rows could not be read');
    return { status: 'failed', general: 0, sent: 0 };
  }
  /* `_icontains` is a pre-filter; the rule is the shared one (exact words). */
  const general = (rows ?? []).filter((r) => isGeneralCouponType(r.coupon_type));
  let sent = 0;
  for (const row of general) {
    const told = await alertGeneralCoupon(
      deps,
      { source: 'compensation', id: row.id, stage: 'requested' },
      async () => compensationFacts(row),
    );
    if (told === 'sent') sent += 1;
  }
  if (sent) logger.info({ general: general.length, sent }, 'general coupon request alert ran');
  return { status: 'ok', general: general.length, sent };
}

/** One job scheduler, however many worker tasks. `0` removes it. */
export async function scheduleGeneralCouponRequestAlert(
  queue: Queue,
  everyMs: number,
): Promise<void> {
  if (!(everyMs > 0)) {
    await queue.removeJobScheduler(SCHEDULER);
    return;
  }
  await queue.upsertJobScheduler(
    SCHEDULER,
    { every: everyMs },
    {
      name: GENERAL_COUPON_REQUEST_ALERT_JOB,
      data: {},
      opts: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
    },
  );
}
