import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ComplaintType,
  CouponRequestDraftChecked,
  ServiceType,
  YIJI_COMPLAINT_SOURCE,
  buildStoreIndex,
  couponCountsAsCompensation,
  couponDecision,
  couponExposure,
  couponIsSuperseded,
  couponPrefix,
  couponRequestProblem,
  defaultCouponDates,
  findIssuingSide,
  generateCouponCode,
  isDialablePhone,
  matchStore,
  normaliseTicketStatus,
  normalizePhone,
  toStoreSnapshot,
  type CouponRequestDraft,
  type StoreRecord,
  type StoreSnapshot,
} from '@yiji/shared-types';
import { verifyWebhookSignature } from './webhook.js';
import { createTokenBucket, type TokenBucket } from './rate-limit.js';

/**
 * THE YIJI INBOUND API (owner, 2026-10-27).
 *
 * Yiji (the food platform whose app this CRM supports) raises tickets in the
 * CRM, optionally with a compensation coupon REQUEST, and reads back what
 * became of them:
 *
 *   POST /webhooks/yiji/tickets                         ticket (+ optional coupon)
 *   POST /webhooks/yiji/tickets/:externalId/coupons     a coupon for an existing one
 *   GET  /webhooks/yiji/tickets/:externalId             status + its coupons
 *
 * Mounted under `/webhooks/` because the ALB already forwards that prefix to
 * this service; anything else would go to Directus and need a new rule.
 *
 * The rules this file exists to keep:
 *
 *  - A COUPON IS A REQUEST. It arrives `pending` in `coupon_approvals`, exactly
 *    like an agent's, and only a WeCare supervisor can approve it; delivery is
 *    the existing worker's job after that. Nothing here calls Yiji.
 *  - TICKET + COUPON ARE ALL-OR-NOTHING. Everything is validated before the
 *    first write; the ticket is written `Not Compensated`, the coupon after it,
 *    and only then is the ticket marked `Compensated`. If the coupon cannot be
 *    stored the ticket is deleted again, so there is never a ticket claiming a
 *    coupon that does not exist (the 2026-10-25 Shatha incident, from the
 *    other side).
 *  - IDEMPOTENT BY YIJI'S OWN IDS. The same ticket / coupon `externalId`
 *    returns the record already written (200), never a second one - backed by
 *    partial unique indexes, so even a race cannot duplicate.
 *  - EVERY TICKET HAS A BRANCH (ticket-branch-mandatory). Yiji's restaurant id
 *    must resolve to a store, or the request is refused before anything is
 *    written.
 *  - BAD INPUT IS A 400 WITH FIELD MESSAGES, never a 500.
 */

/* ── The store this needs (Directus in production, a fake in tests) ──────── */

export type InboundStoreErrorKind = 'duplicate' | 'transient' | 'refused';

/** A storage failure, already sorted into what it means for a retry. */
export class InboundStoreError extends Error {
  readonly kind: InboundStoreErrorKind;
  /** For `duplicate`: the column that clashed, when the store said. */
  readonly field: string | null;
  constructor(kind: InboundStoreErrorKind, message: string, field: string | null = null) {
    super(message);
    this.name = 'InboundStoreError';
    this.kind = kind;
    this.field = field;
  }
}

export interface InboundTicket {
  id: string;
  externalId: string | null;
  status: string | null;
  compensation: string | null;
  contactId: string | null;
  customerPhone: string | null;
  orderId: string | null;
  description: string | null;
  /** Yiji's restaurant id of the ticket's branch, for a coupon added later. */
  restaurantId: string | null;
  dateCreated: string | null;
  resolvedAt: string | null;
}

export interface InboundCoupon {
  id: string;
  externalId: string | null;
  ticketId: string | null;
  code: string | null;
  status: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  value: number | null;
  percent: number | null;
  maxDiscount: number | null;
  validFrom: string | null;
  validTo: string | null;
  removalStatus: string | null;
  replacedBy: string | null;
  dateCreated: string | null;
}

export interface NewTicketRow {
  id: string;
  vendor: string;
  external_id: string;
  subject: string;
  description: string | null;
  status: 'pending';
  priority: 'medium';
  contact: string;
  customer_phone: string;
  order_id: string | null;
  store: string;
  store_snapshot: StoreSnapshot;
  complaint_date: string | null;
  complaint_type: string;
  service_type: string | null;
  complaint_source: typeof YIJI_COMPLAINT_SOURCE;
  compensation: 'Not Compensated';
  assigned_team?: string;
}

export interface NewCouponRow {
  id: string;
  vendor: string;
  external_id: string;
  ticket: string;
  contact: string | null;
  customer_phone: string | null;
  order_id: string | null;
  requested_by: string | null;
  status: 'pending';
  reason: string;
  coupon_code: string;
  coupon_value: number | null;
  coupon_percent: number | null;
  compensation: 'Compensated';
  title: string;
  issuing_side: string;
  delivery_type: string;
  coupon_type: string;
  discount_category: string;
  valid_from: string;
  valid_to: string;
  max_discount: number;
  usage_limit: number;
  brand_id: string | null;
  restaurant_id: string | null;
  item_name: string | null;
  item_sku: string | null;
  no_other_discounts: boolean;
  delivery_excluded: false;
}

export interface YijiInboundStore {
  /** The CRM uuid of the Yiji vendor, or null when it is not set up. */
  yijiVendorId(): Promise<string | null>;
  findTicket(vendor: string, externalId: string): Promise<InboundTicket | null>;
  findCoupon(vendor: string, externalId: string): Promise<InboundCoupon | null>;
  couponExists(id: string): Promise<boolean>;
  ticketCoupons(ticketId: string): Promise<InboundCoupon[]>;
  stores(): Promise<StoreRecord[]>;
  /** Find the customer by phone (+ vendor) or create them. Returns the contact id. */
  upsertContact(
    vendor: string,
    c: { phone: string; name: string | null; yijiCustomerId: string | null },
  ): Promise<string>;
  couponCodeTaken(code: string): Promise<boolean>;
  createTicket(row: NewTicketRow): Promise<void>;
  deleteTicket(id: string): Promise<void>;
  createCoupon(row: NewCouponRow): Promise<void>;
  setTicketCompensation(id: string, value: 'Compensated' | 'Not Compensated'): Promise<void>;
  addTicketEvent(
    ticketId: string,
    actor: string | null,
    text: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  /** Who a Yiji request is recorded as (the "Yiji" system user), or null. */
  actorId(): Promise<string | null>;
}

/* ── The CRM-side compensation policy (OFF by default) ────────────────────── */

/**
 * Compensation policy is applied on YIJI's side (owner, 2026-10-27). This is
 * the CRM's own check, built now and OFF, so it can be switched on with an env
 * flag rather than a rebuild. Off, it still runs and LOGS what it would have
 * refused, so the limits can be tuned from real traffic before enforcing.
 */
export interface CouponPolicy {
  enforce: boolean;
  /** Most a single coupon may ever cost, in SAR (see `couponExposure`). */
  maxExposureSar: number;
  maxPercent: number;
  /** Longest validity window, in whole days, inclusive. */
  maxValidityDays: number;
}

export const DEFAULT_COUPON_POLICY: CouponPolicy = {
  enforce: false,
  maxExposureSar: 200,
  maxPercent: 100,
  maxValidityDays: 90,
};

const DAY_MS = 86_400_000;

/** What this policy would refuse about a coupon, keyed by API field. Empty = fine. */
export function couponPolicyProblems(
  draft: Pick<
    CouponRequestDraft,
    | 'discount_category'
    | 'coupon_value'
    | 'coupon_percent'
    | 'max_discount'
    | 'valid_from'
    | 'valid_to'
  >,
  policy: CouponPolicy,
): Record<string, string> {
  const out: Record<string, string> = {};
  const pct = draft.discount_category === 'Percentage';
  const exposure = couponExposure(draft);
  if (exposure > policy.maxExposureSar) {
    out[pct ? 'coupon.maxDiscount' : 'coupon.value'] =
      `Above the CRM limit of SAR ${policy.maxExposureSar} per coupon.`;
  }
  if (pct && (draft.coupon_percent ?? 0) > policy.maxPercent) {
    out['coupon.percent'] = `Above the CRM limit of ${policy.maxPercent}%.`;
  }
  const days =
    Math.round(
      (Date.parse(`${draft.valid_to}T00:00:00Z`) - Date.parse(`${draft.valid_from}T00:00:00Z`)) /
        DAY_MS,
    ) + 1;
  if (Number.isFinite(days) && days > policy.maxValidityDays) {
    out['coupon.validTo'] = `Valid for ${days} days; the CRM limit is ${policy.maxValidityDays}.`;
  }
  return out;
}

/* ── Request bodies ────────────────────────────────────────────────────────── */

const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const EXTERNAL_ID_MESSAGE =
  'Use 1-100 characters: letters, digits, dot, underscore, colon or hyphen.';

/** An id Yiji may send as a number or a string; stored as text. */
const idText = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().min(1, 'Must not be empty.').max(max, `At most ${max} characters.`));

const externalId = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(EXTERNAL_ID, EXTERNAL_ID_MESSAGE));

const optionalText = (max: number) =>
  z
    .string()
    .max(max, `At most ${max} characters.`)
    .nullish()
    .transform((v) => (v?.trim() ? v.trim() : null));

/** `YYYY-MM-DD`, or a full ISO timestamp whose date part is used. */
const dateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'Use YYYY-MM-DD.')
  .transform((v) => v.slice(0, 10))
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date.');

/** Case-insensitive match onto the CRM's own spelling of a value. */
function canonical(list: readonly string[], raw: string): string | undefined {
  const key = raw.trim().toLowerCase();
  return list.find((x) => x.toLowerCase() === key);
}

const SERVICE_TYPE_ALIASES: Record<string, string> = {
  'dine-in': 'Dinning',
  'dine in': 'Dinning',
  dinein: 'Dinning',
  dining: 'Dinning',
  takeout: 'TakeOut',
  takeaway: 'TakeOut',
  'drive-thru': 'Drive Thru',
  'drive thru': 'Drive Thru',
  carhop: 'Drive Thru',
};

/** The delivery-type words the coupon form stores (option_lists.delivery_type). */
const DELIVERY_TYPES = ['All', 'Delivery', 'Pickup', 'Carhop', 'Takeout', 'Dine-in'] as const;
const DELIVERY_ALIASES: Record<string, (typeof DELIVERY_TYPES)[number]> = {
  'dine in': 'Dine-in',
  dinein: 'Dine-in',
  takeaway: 'Takeout',
  'drive thru': 'Carhop',
  'drive-thru': 'Carhop',
};

export const CouponBody = z.object({
  externalId,
  type: z.enum(['amount', 'percentage'], {
    errorMap: () => ({ message: 'Use "amount" or "percentage".' }),
  }),
  /** SAR off, for an amount coupon. */
  value: z.number().nullish(),
  /** Percent off, for a percentage coupon. */
  percent: z.number().nullish(),
  /** Ceiling in SAR. Required for a percentage coupon. */
  maxDiscount: z.number().nullish(),
  validFrom: dateOnly.nullish(),
  validTo: dateOnly.nullish(),
  reason: optionalText(2000),
  deliveryTypes: z.array(z.string()).max(6, 'At most 6 delivery types.').nullish(),
  item: z
    .object({
      name: z.string().trim().min(1, 'Must not be empty.').max(200),
      sku: idText(64).nullish(),
    })
    .nullish(),
  /** A CRM issuing side (default "Customer Care"). */
  issuingSide: optionalText(60),
  /** private (default) or general. */
  audience: z
    .enum(['private', 'general'], { errorMap: () => ({ message: 'Use "private" or "general".' }) })
    .nullish(),
  usageLimit: z.number().int('Must be a whole number.').min(1).max(100).nullish(),
  /** True = cannot be combined with other discounts (default false). */
  noOtherDiscounts: z.boolean().nullish(),
});
export type CouponBody = z.infer<typeof CouponBody>;

export const TicketBody = z.object({
  externalId,
  customer: z.object({
    phone: z
      .string({ required_error: 'Required.' })
      .trim()
      .refine(
        (v) => isDialablePhone(v),
        'Not a valid mobile number (e.g. 05XXXXXXXX or +9665XXXXXXXX).',
      ),
    name: optionalText(120),
    yijiCustomerId: idText(64).nullish(),
  }),
  orderNumber: idText(64).nullish(),
  restaurantId: idText(64),
  /** Optional: helps match a branch whose Yiji id is not in the store master yet. */
  restaurantName: optionalText(200),
  brandName: optionalText(200),
  brandId: idText(64).nullish(),
  subject: optionalText(200),
  description: optionalText(5000),
  complaintType: z.string({ required_error: 'Required.' }).trim().min(1, 'Required.'),
  serviceType: optionalText(40),
  attachments: z
    .array(
      z
        .string()
        .trim()
        .url('Not a URL.')
        .max(2000)
        .refine((v) => v.startsWith('https://'), 'Use an https:// URL.'),
    )
    .max(10, 'At most 10 attachments.')
    .nullish(),
  occurredAt: z
    .string()
    .trim()
    .refine(
      (v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)),
      'Use an ISO 8601 date-time, e.g. 2026-10-27T14:30:00+03:00.',
    )
    .nullish(),
  coupon: CouponBody.nullish(),
});
export type TicketBody = z.infer<typeof TicketBody>;

/** Field-level messages for a failed parse, keyed by dotted path. */
export function zodFieldErrors(err: z.ZodError, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = [prefix, ...issue.path.map(String)].filter(Boolean).join('.') || 'body';
    if (out[key]) continue;
    const missing = issue.code === 'invalid_type' && issue.received === 'undefined';
    out[key] = missing ? 'Required.' : issue.message;
  }
  return out;
}

/* ── Errors that become HTTP answers ─────────────────────────────────────── */

export class InboundHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'InboundHttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
  toBody(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.fields ? { fields: this.fields } : {}),
    };
  }
}

const invalid = (fields: Record<string, string>): InboundHttpError =>
  new InboundHttpError(400, 'validation_failed', 'The request has invalid fields.', fields);

/* ── Turning a coupon body into the CRM's coupon terms ───────────────────── */

/** Draft field -> the API field Yiji sent it as, for error messages. */
const DRAFT_TO_API: Record<string, string> = {
  title: 'customer.phone',
  code: 'coupon.externalId',
  issuing_side: 'coupon.issuingSide',
  delivery_type: 'coupon.deliveryTypes',
  coupon_type: 'coupon.audience',
  discount_category: 'coupon.type',
  valid_from: 'coupon.validFrom',
  valid_to: 'coupon.validTo',
  coupon_value: 'coupon.value',
  coupon_percent: 'coupon.percent',
  max_discount: 'coupon.maxDiscount',
  usage_limit: 'coupon.usageLimit',
  compensation_reason: 'coupon.reason',
  item_name: 'coupon.item.name',
  item_sku: 'coupon.item.sku',
};

/** A placeholder that satisfies the draft's code rule; the real code is minted later. */
const CODE_PLACEHOLDER = 'PENDING-CODE';

export interface CouponPlan {
  externalId: string;
  draft: CouponRequestDraft;
}

/**
 * Validate a coupon exactly as the agent's form does (`CouponRequestDraftChecked`
 * + `couponRequestProblem`) and build its terms. Throws a 400 with field
 * messages, keyed `coupon.*`, when it is not a valid coupon.
 */
export function planCoupon(
  c: CouponBody,
  ctx: {
    phone: string;
    description: string | null;
    restaurantId: string | null;
    brandId: string | null;
    today: Date;
  },
): CouponPlan {
  const fields: Record<string, string> = {};
  const pct = c.type === 'percentage';
  if (pct && c.value != null) fields['coupon.value'] = 'Use "percent" for a percentage coupon.';
  if (!pct && c.percent != null) fields['coupon.percent'] = 'Use "value" for an amount coupon.';

  const side = findIssuingSide(c.issuingSide ?? 'Customer Care');
  if (!side) fields['coupon.issuingSide'] = 'Not a known issuing side.';

  let deliveryType = 'All';
  if (c.deliveryTypes && c.deliveryTypes.length > 0) {
    const picked: string[] = [];
    for (const raw of c.deliveryTypes) {
      const key = raw.trim().toLowerCase();
      const word = DELIVERY_TYPES.find((d) => d.toLowerCase() === key) ?? DELIVERY_ALIASES[key];
      if (!word) {
        fields['coupon.deliveryTypes'] =
          `Unknown delivery type "${raw}". Use: ${DELIVERY_TYPES.join(', ')}.`;
        break;
      }
      if (!picked.includes(word)) picked.push(word);
    }
    deliveryType = picked.includes('All')
      ? 'All'
      : DELIVERY_TYPES.filter((d) => picked.includes(d)).join(', ') || 'All';
  }

  /* The agent form's own money rule: for an AMOUNT the ceiling IS the amount,
     unless a smaller cap was given - which couponTermsProblems then refuses. */
  const value = pct ? null : (c.value ?? null);
  const percent = pct ? (c.percent ?? null) : null;
  const cap = pct
    ? (c.maxDiscount ?? 0)
    : c.maxDiscount != null && value != null && c.maxDiscount < value
      ? c.maxDiscount
      : (value ?? 0);
  const dates = defaultCouponDates(ctx.today);

  const draft: CouponRequestDraft = {
    title: ctx.phone,
    code: CODE_PLACEHOLDER,
    issuing_side: side?.value ?? 'Customer Care',
    delivery_type: deliveryType,
    coupon_type: c.audience === 'general' ? 'Public' : 'Private',
    discount_category: pct ? 'Percentage' : 'Amount',
    valid_from: c.validFrom ?? dates.valid_from,
    valid_to: c.validTo ?? dates.valid_to,
    coupon_value: value,
    coupon_percent: percent,
    max_discount: cap,
    usage_limit: c.usageLimit ?? 1,
    compensation_reason: (c.reason ?? ctx.description ?? '').slice(0, 2000),
    brand_id: ctx.brandId,
    restaurant_id: ctx.restaurantId,
    item_name: c.item?.name ?? null,
    item_sku: c.item?.sku ?? null,
    no_other_discounts: c.noOtherDiscounts === true,
    delivery_excluded: false,
    delivery_excluded_reason: null,
  };

  const problem = couponRequestProblem({
    coupon_code: '',
    coupon_value: value == null ? '' : String(value),
    coupon_percent: percent == null ? '' : String(percent),
    compensation: 'Compensated',
  });
  if (problem === 'none-requested') {
    fields[pct ? 'coupon.percent' : 'coupon.value'] ??=
      'Required: a coupon must be worth something.';
  } else if (problem === 'bad-numbers') {
    fields[pct ? 'coupon.percent' : 'coupon.value'] ??= 'Out of range.';
  }

  const checked = CouponRequestDraftChecked.safeParse(draft);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      const key = DRAFT_TO_API[String(issue.path[0] ?? '')] ?? 'coupon';
      fields[key] ??= issue.message;
    }
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return { externalId: c.externalId, draft: checked.success ? checked.data : draft };
}

/* ── The service ──────────────────────────────────────────────────────────── */

export interface InboundLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface YijiInboundOptions {
  store: YijiInboundStore;
  policy?: CouponPolicy;
  /** Team a Yiji ticket lands on (`assigned_team`); unset = no team. */
  teamId?: string | null;
  logger: InboundLogger;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between coupon-write attempts; its length + 1 is the attempt count. */
  retryDelaysMs?: readonly number[];
}

export interface InboundResult {
  status: number;
  body: Record<string, unknown>;
}

/** A short, human reference for a ticket: the first 8 characters of its id. */
export function ticketNumber(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** The status Yiji reads back for one coupon. */
export function apiCouponStatus(c: {
  status: string | null;
  removalStatus: string | null;
  replacedBy: string | null;
}): 'pending' | 'approved' | 'assigned' | 'rejected' | 'removed' | 'replaced' {
  if (c.replacedBy) return 'replaced';
  if (c.removalStatus === 'removed' || c.removalStatus === 'not_on_yiji') return 'removed';
  if ((c.status ?? '').trim().toLowerCase() === 'assigned') return 'assigned';
  const d = couponDecision(c.status);
  return d === 'approved' ? 'approved' : d === 'rejected' ? 'rejected' : 'pending';
}

const couponSummary = (c: InboundCoupon) => ({
  id: c.id,
  externalId: c.externalId,
  code: c.code,
  status: apiCouponStatus(c),
});

const couponDetail = (c: InboundCoupon) => ({
  ...couponSummary(c),
  value: c.value,
  percent: c.percent,
  maxDiscount: c.maxDiscount,
  validFrom: c.validFrom,
  validTo: c.validTo,
  decisionNote: c.decisionNote,
  decidedAt: c.decidedAt,
  createdAt: c.dateCreated,
});

const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;

/* Yiji's attachment URLs are listed under the description - never fetched:
   the CRM does not download from a URL a caller hands it. */
const ATTACHMENTS_HEADING = 'Attachments from Yiji:';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const asStoreError = (err: unknown): InboundStoreError =>
  err instanceof InboundStoreError
    ? err
    : new InboundStoreError('transient', (err as Error)?.message ?? String(err));

const unavailable = (message = 'Temporarily unavailable. Retry the same request.') =>
  new InboundHttpError(503, 'unavailable', message);

export function createYijiInboundService(opts: YijiInboundOptions) {
  const { store, logger } = opts;
  const policy = opts.policy ?? DEFAULT_COUPON_POLICY;
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const newId = opts.newId ?? randomUUID;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  /** Retry a small write on transient failures only; rethrows the last error. */
  async function retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const e = asStoreError(err);
        if (e.kind !== 'transient' || attempt >= delays.length) throw e;
        await sleep(delays[attempt] ?? 0);
      }
    }
  }

  async function vendor(): Promise<string> {
    let id: string | null;
    try {
      id = await store.yijiVendorId();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'yiji inbound: vendor lookup failed');
      throw unavailable();
    }
    if (!id)
      throw new InboundHttpError(
        503,
        'not_configured',
        'The Yiji vendor is not set up in the CRM.',
      );
    return id;
  }

  /** Apply (or, when off, only log) the CRM-side compensation policy. */
  function checkPolicy(plan: CouponPlan, ticketExternalId: string): void {
    const problems = couponPolicyProblems(plan.draft, policy);
    if (Object.keys(problems).length === 0) return;
    if (!policy.enforce) {
      logger.info(
        { ticket: ticketExternalId, coupon: plan.externalId, problems },
        'yiji inbound: coupon outside the CRM policy (not enforced)',
      );
      return;
    }
    throw new InboundHttpError(
      422,
      'policy_violation',
      'The coupon is outside the CRM compensation policy.',
      problems,
    );
  }

  async function freshCode(issuingSide: string): Promise<string> {
    for (let i = 0; i < 6; i++) {
      const code = generateCouponCode(random, couponPrefix(issuingSide));
      if (!(await retrying(() => store.couponCodeTaken(code)))) return code;
    }
    throw unavailable('Could not allocate a coupon code. Retry the same request.');
  }

  /** Keep the ticket's Compensation in step with its coupons (best-effort). */
  async function syncCompensation(ticket: InboundTicket, coupons: InboundCoupon[]): Promise<void> {
    const counts = coupons.some(
      (c) =>
        couponCountsAsCompensation({ status: c.status, removal_status: c.removalStatus }) &&
        !couponIsSuperseded({ status: c.status, replaced_by: c.replacedBy }),
    );
    if (!counts || ticket.compensation === 'Compensated') return;
    try {
      await retrying(() => store.setTicketCompensation(ticket.id, 'Compensated'));
      ticket.compensation = 'Compensated';
    } catch (err) {
      logger.warn(
        { ticketId: ticket.id, err: (err as Error)?.message },
        'yiji inbound: coupon stored, ticket not yet marked Compensated',
      );
    }
  }

  async function history(ticketId: string, text: string, payload: Record<string, unknown>) {
    try {
      const actor = await store.actorId().catch(() => null);
      await store.addTicketEvent(ticketId, actor, text, payload);
    } catch (err) {
      logger.warn(
        { ticketId, err: (err as Error)?.message },
        'yiji inbound: history line not written',
      );
    }
  }

  /**
   * Write the coupon row for a ticket. Idempotent: OUR id is made before the
   * first attempt, so a retry after a lost answer finds the row it wrote.
   * Resolves with the stored coupon (ours, or the one a racing request wrote
   * under the same external id).
   */
  async function storeCoupon(
    vendorId: string,
    ticket: InboundTicket,
    plan: CouponPlan,
  ): Promise<{ coupon: InboundCoupon; created: boolean }> {
    const d = plan.draft;
    const row: NewCouponRow = {
      id: newId(),
      vendor: vendorId,
      external_id: plan.externalId,
      ticket: ticket.id,
      contact: ticket.contactId,
      customer_phone: ticket.customerPhone,
      order_id: ticket.orderId,
      requested_by: await store.actorId().catch(() => null),
      status: 'pending',
      reason: d.compensation_reason,
      coupon_code: await freshCode(d.issuing_side),
      coupon_value: d.coupon_value ?? null,
      coupon_percent: d.coupon_percent ?? null,
      compensation: 'Compensated',
      title: d.title,
      issuing_side: d.issuing_side,
      delivery_type: d.delivery_type,
      coupon_type: d.coupon_type,
      discount_category: d.discount_category,
      valid_from: d.valid_from,
      valid_to: d.valid_to,
      max_discount: d.max_discount,
      usage_limit: d.usage_limit,
      brand_id: d.brand_id ?? null,
      restaurant_id: d.restaurant_id ?? null,
      item_name: d.item_name ?? null,
      item_sku: d.item_sku ?? null,
      no_other_discounts: d.no_other_discounts,
      delivery_excluded: false,
    };
    const exists = async (): Promise<boolean> => {
      try {
        return await store.couponExists(row.id);
      } catch {
        return false;
      }
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await store.createCoupon(row);
        break;
      } catch (err) {
        const e = asStoreError(err);
        if (await exists()) break; // an earlier attempt landed; only the answer was lost
        if (e.kind === 'duplicate') {
          const raced = await store.findCoupon(vendorId, plan.externalId).catch(() => null);
          if (raced) {
            if (raced.ticketId !== ticket.id) throw couponConflict(plan.externalId);
            return { coupon: raced, created: false };
          }
          if (attempt < delays.length) {
            row.coupon_code = await freshCode(d.issuing_side); // the CODE clashed
            continue;
          }
        }
        if (e.kind === 'transient' && attempt < delays.length) {
          await sleep(delays[attempt] ?? 0);
          continue;
        }
        throw e;
      }
    }
    return {
      created: true,
      coupon: {
        id: row.id,
        externalId: row.external_id,
        ticketId: ticket.id,
        code: row.coupon_code,
        status: 'pending',
        decisionNote: null,
        decidedAt: null,
        value: row.coupon_value,
        percent: row.coupon_percent,
        maxDiscount: row.max_discount,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        removalStatus: null,
        replacedBy: null,
        dateCreated: now().toISOString(),
      },
    };
  }

  const couponConflict = (ext: string) =>
    new InboundHttpError(
      409,
      'coupon_external_id_conflict',
      `Coupon externalId "${ext}" already belongs to a different ticket.`,
      { 'coupon.externalId': 'Already used on a different ticket.' },
    );

  /**
   * The coupon with this external id on THIS ticket: the existing one, or a
   * new one written now (then the ticket is marked Compensated).
   */
  async function ensureCoupon(
    vendorId: string,
    ticket: InboundTicket,
    plan: CouponPlan,
  ): Promise<{ coupon: InboundCoupon; created: boolean }> {
    const existing = await store.findCoupon(vendorId, plan.externalId);
    if (existing) {
      if (existing.ticketId !== ticket.id) throw couponConflict(plan.externalId);
      return { coupon: existing, created: false };
    }
    const out = await storeCoupon(vendorId, ticket, plan);
    if (out.created) {
      await history(
        ticket.id,
        `Coupon requested by Yiji (externalId ${plan.externalId}, code ${out.coupon.code}) - waiting for a WeCare supervisor.`,
        {
          coupon_request: { id: out.coupon.id, outcome: 'sent', source: 'yiji' },
          yiji_inbound: { couponExternalId: plan.externalId },
        },
      );
    }
    return out;
  }

  const ticketBody = (t: InboundTicket) => ({
    ticketId: t.id,
    ticketNumber: ticketNumber(t.id),
    externalId: t.externalId,
  });

  /** POST /tickets */
  async function createTicket(raw: unknown): Promise<InboundResult> {
    const parsed = TicketBody.safeParse(raw);
    if (!parsed.success) throw invalid(zodFieldErrors(parsed.error));
    const b = parsed.data;

    const fields: Record<string, string> = {};
    const complaintType = canonical(ComplaintType.options, b.complaintType);
    if (!complaintType) {
      fields.complaintType = `Unknown complaint type. Use one of: ${ComplaintType.options.join(', ')}.`;
    }
    let serviceType: string | null = null;
    if (b.serviceType) {
      serviceType =
        canonical(ServiceType.options, b.serviceType) ??
        SERVICE_TYPE_ALIASES[b.serviceType.trim().toLowerCase()] ??
        null;
      if (!serviceType) {
        fields.serviceType = `Unknown service type. Use one of: ${ServiceType.options.join(', ')}.`;
      }
    }
    const phone = normalizePhone(b.customer.phone);
    let plan: CouponPlan | null = null;
    try {
      plan = b.coupon
        ? planCoupon(b.coupon, {
            phone,
            description: b.description,
            restaurantId: b.restaurantId,
            brandId: b.brandId ?? null,
            today: now(),
          })
        : null;
    } catch (err) {
      if (!(err instanceof InboundHttpError) || !err.fields) throw err;
      Object.assign(fields, err.fields);
    }
    if (Object.keys(fields).length > 0) throw invalid(fields);

    const vendorId = await vendor();

    /* IDEMPOTENT REPLAY: the ticket is already here. Return it - and, if this
       call carries a coupon the ticket does not have yet (a retry after a
       rolled-back or half-finished call), finish the job. */
    const existing = await store.findTicket(vendorId, b.externalId);
    if (existing) return replay(vendorId, existing, plan);

    /* THE BRANCH, before anything is written. */
    let stores: StoreRecord[];
    try {
      stores = await retrying(() => store.stores());
    } catch {
      throw unavailable();
    }
    const match = matchStore(buildStoreIndex(stores), {
      restaurantId: b.restaurantId,
      restaurantName: b.restaurantName,
      brandName: b.brandName,
    });
    if (!match.store) {
      throw new InboundHttpError(
        422,
        'unknown_restaurant',
        'The restaurant is not mapped to a CRM branch; every ticket needs one.',
        { restaurantId: `No CRM branch carries Yiji restaurant id "${b.restaurantId}".` },
      );
    }
    if (plan) {
      checkPolicy(plan, b.externalId);
      const taken = await store.findCoupon(vendorId, plan.externalId);
      if (taken) throw couponConflict(plan.externalId);
    }

    const contactId = await retrying(() =>
      store.upsertContact(vendorId, {
        phone,
        name: b.customer.name,
        yijiCustomerId: b.customer.yijiCustomerId ?? null,
      }),
    );

    const attachments = b.attachments ?? [];
    const description =
      [
        b.description ?? '',
        attachments.length > 0
          ? `${ATTACHMENTS_HEADING}\n${attachments.map((u) => `- ${u}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n') || null;

    const row: NewTicketRow = {
      id: newId(),
      vendor: vendorId,
      external_id: b.externalId,
      subject: b.subject ?? complaintType!,
      description,
      status: 'pending',
      priority: 'medium',
      contact: contactId,
      customer_phone: phone,
      order_id: b.orderNumber ?? null,
      store: match.store.id,
      store_snapshot: toStoreSnapshot(match, now().toISOString()),
      complaint_date: b.occurredAt ? new Date(b.occurredAt).toISOString() : null,
      complaint_type: complaintType!,
      service_type: serviceType,
      complaint_source: YIJI_COMPLAINT_SOURCE,
      /* NOT Compensated until the coupon row exists (owner, 2026-10-21/25). */
      compensation: 'Not Compensated',
      ...(opts.teamId ? { assigned_team: opts.teamId } : {}),
    };

    try {
      await retrying(() => store.createTicket(row));
    } catch (err) {
      const e = asStoreError(err);
      /* A racing request with the same external id won: answer with its ticket. */
      const raced = await store.findTicket(vendorId, b.externalId).catch(() => null);
      if (raced && raced.id !== row.id) return replay(vendorId, raced, plan);
      if (raced) {
        /* Ours landed and only the answer was lost. */
      } else {
        logger.warn(
          { externalId: b.externalId, err: e.message, kind: e.kind },
          'yiji inbound: ticket not stored',
        );
        throw unavailable();
      }
    }

    const ticket: InboundTicket = {
      id: row.id,
      externalId: row.external_id,
      status: 'pending',
      compensation: row.compensation,
      contactId,
      customerPhone: phone,
      orderId: row.order_id,
      description,
      restaurantId: b.restaurantId,
      dateCreated: now().toISOString(),
      resolvedAt: null,
    };

    let coupon: InboundCoupon | null = null;
    if (plan) {
      try {
        coupon = (await storeCoupon(vendorId, ticket, plan)).coupon;
      } catch (err) {
        /* ALL OR NOTHING: no coupon row, so no ticket either. */
        const reason = err instanceof Error ? err.message : String(err);
        try {
          await retrying(() => store.deleteTicket(ticket.id));
          logger.warn(
            { externalId: b.externalId, ticketId: ticket.id, reason },
            'yiji inbound: coupon not stored - ticket rolled back',
          );
        } catch (delErr) {
          /* The ticket stays, Not Compensated and couponless - never a false
             "Compensated". A retry of this request completes it (replay). */
          logger.error(
            {
              externalId: b.externalId,
              ticketId: ticket.id,
              reason,
              err: (delErr as Error)?.message,
            },
            'yiji inbound: coupon not stored AND rollback failed - ticket left Not Compensated',
          );
        }
        if (err instanceof InboundHttpError) throw err;
        throw unavailable(
          'The coupon could not be stored, so the ticket was not created. Retry the same request.',
        );
      }
      await syncCompensation(ticket, [coupon]);
    }

    await history(ticket.id, `Created by Yiji (externalId ${b.externalId}).`, {
      yiji_inbound: {
        externalId: b.externalId,
        orderNumber: b.orderNumber ?? null,
        restaurantId: b.restaurantId,
        attachments,
      },
    });
    if (coupon && plan) {
      await history(
        ticket.id,
        `Coupon requested by Yiji (externalId ${plan.externalId}, code ${coupon.code}) - waiting for a WeCare supervisor.`,
        {
          coupon_request: { id: coupon.id, outcome: 'sent', source: 'yiji' },
          yiji_inbound: { couponExternalId: plan.externalId },
        },
      );
    }
    logger.info(
      { externalId: b.externalId, ticketId: ticket.id, coupon: coupon?.id ?? null },
      'yiji inbound: ticket created',
    );
    return {
      status: 201,
      body: { ...ticketBody(ticket), ...(coupon ? { coupon: couponSummary(coupon) } : {}) },
    };
  }

  async function replay(
    vendorId: string,
    ticket: InboundTicket,
    plan: CouponPlan | null,
  ): Promise<InboundResult> {
    let coupon: InboundCoupon | null = null;
    if (plan) {
      const found = await store.findCoupon(vendorId, plan.externalId);
      if (found && found.ticketId !== ticket.id) throw couponConflict(plan.externalId);
      if (found) coupon = found;
      else {
        checkPolicy(plan, ticket.externalId ?? '');
        try {
          coupon = (await ensureCoupon(vendorId, ticket, plan)).coupon;
        } catch (err) {
          if (err instanceof InboundHttpError) throw err;
          throw unavailable('The coupon could not be stored. Retry the same request.');
        }
      }
    }
    const coupons = await store.ticketCoupons(ticket.id).catch(() => (coupon ? [coupon] : []));
    await syncCompensation(ticket, coupons);
    return {
      status: 200,
      body: { ...ticketBody(ticket), ...(coupon ? { coupon: couponSummary(coupon) } : {}) },
    };
  }

  /** POST /tickets/:externalId/coupons */
  async function addCoupon(ticketExternalId: string, raw: unknown): Promise<InboundResult> {
    if (!EXTERNAL_ID.test(ticketExternalId)) {
      throw new InboundHttpError(404, 'ticket_not_found', 'No ticket with that externalId.');
    }
    const parsed = CouponBody.safeParse(raw);
    if (!parsed.success) throw invalid(zodFieldErrors(parsed.error, 'coupon'));
    const vendorId = await vendor();
    const ticket = await store.findTicket(vendorId, ticketExternalId);
    if (!ticket)
      throw new InboundHttpError(404, 'ticket_not_found', 'No ticket with that externalId.');

    const plan = planCoupon(parsed.data, {
      phone: normalizePhone(ticket.customerPhone) || '',
      /* The complaint itself, without the attachment list appended to it. */
      description: ticket.description?.split(`\n\n${ATTACHMENTS_HEADING}`)[0] ?? null,
      restaurantId: ticket.restaurantId,
      brandId: null,
      today: now(),
    });
    const found = await store.findCoupon(vendorId, plan.externalId);
    if (found) {
      if (found.ticketId !== ticket.id) throw couponConflict(plan.externalId);
      return { status: 200, body: { ...ticketBody(ticket), coupon: couponSummary(found) } };
    }
    checkPolicy(plan, ticketExternalId);
    let out: { coupon: InboundCoupon; created: boolean };
    try {
      out = await ensureCoupon(vendorId, ticket, plan);
    } catch (err) {
      if (err instanceof InboundHttpError) throw err;
      logger.warn(
        { ticketExternalId, err: (err as Error)?.message },
        'yiji inbound: coupon not stored',
      );
      throw unavailable('The coupon could not be stored. Retry the same request.');
    }
    const coupons = await store.ticketCoupons(ticket.id).catch(() => [out.coupon]);
    await syncCompensation(ticket, coupons);
    return {
      status: out.created ? 201 : 200,
      body: { ...ticketBody(ticket), coupon: couponSummary(out.coupon) },
    };
  }

  /** GET /tickets/:externalId */
  async function readTicket(ticketExternalId: string): Promise<InboundResult> {
    if (!EXTERNAL_ID.test(ticketExternalId)) {
      throw new InboundHttpError(404, 'ticket_not_found', 'No ticket with that externalId.');
    }
    const vendorId = await vendor();
    const ticket = await store.findTicket(vendorId, ticketExternalId);
    if (!ticket)
      throw new InboundHttpError(404, 'ticket_not_found', 'No ticket with that externalId.');
    const coupons = await store.ticketCoupons(ticket.id);
    return {
      status: 200,
      body: {
        ...ticketBody(ticket),
        status: normaliseTicketStatus(ticket.status),
        compensation: ticket.compensation,
        createdAt: ticket.dateCreated,
        solvedAt: ticket.resolvedAt,
        coupons: coupons.map(couponDetail),
      },
    };
  }

  return { createTicket, addCoupon, readTicket };
}

export type YijiInboundService = ReturnType<typeof createYijiInboundService>;

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

export const YIJI_INBOUND_PREFIX = '/webhooks/yiji';

export interface YijiInboundRouteDeps {
  /** `YIJI_INBOUND_API_SECRET`. Empty = every route answers 503. */
  secret: string;
  toleranceSec: number;
  service: YijiInboundService;
  logger: InboundLogger;
  /** Per-caller (IP) token bucket. */
  rate?: { capacity: number; perSec: number };
  nowMs?: () => number;
}

/**
 * Register the three routes under `/webhooks/yiji` (already routed to this
 * service by the ALB). Same signing scheme as `/webhooks/yiji`:
 * `X-Yiji-Signature: sha256=<hex hmac of "<X-Yiji-Timestamp>.<raw body>">`
 * - for the GET the body is empty, so the signed string is `"<ts>."`.
 */
export function registerYijiInboundApi(app: FastifyInstance, deps: YijiInboundRouteDeps): void {
  const { logger } = deps;
  const rate = deps.rate ?? { capacity: 30, perSec: 2 };
  const buckets = new Map<string, TokenBucket>();

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const ip = req.ip || 'unknown';
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size > 5000) buckets.clear(); // bounded: a flood cannot grow this forever
      bucket = createTokenBucket(rate.capacity, rate.perSec);
      buckets.set(ip, bucket);
    }
    if (!bucket.tryRemove()) {
      await reply
        .code(429)
        .header('Retry-After', String(Math.max(1, Math.ceil(1 / Math.max(rate.perSec, 0.001)))))
        .send({ error: 'rate_limited', message: 'Too many requests. Slow down and retry.' });
      return false;
    }
    if (!deps.secret) {
      await reply
        .code(503)
        .send({ error: 'not_configured', message: 'The Yiji inbound API is not configured.' });
      return false;
    }
    const result = verifyWebhookSignature({
      secret: deps.secret,
      rawBody: (req as { rawBody?: string }).rawBody ?? '',
      signature: req.headers['x-yiji-signature'] as string | undefined,
      timestamp: req.headers['x-yiji-timestamp'] as string | undefined,
      toleranceSec: deps.toleranceSec,
      ...(deps.nowMs ? { nowMs: deps.nowMs() } : {}),
    });
    if (!result.valid) {
      logger.warn({ reason: result.reason, ip }, 'yiji inbound: signature rejected');
      await reply
        .code(401)
        .send({ error: 'invalid_signature', message: 'Signature or timestamp is not valid.' });
      return false;
    }
    return true;
  };

  const answer = async (reply: FastifyReply, run: () => Promise<InboundResult>) => {
    try {
      const out = await run();
      return reply.code(out.status).send(out.body);
    } catch (err) {
      if (err instanceof InboundHttpError) return reply.code(err.status).send(err.toBody());
      /* Never a 500 for Yiji: anything unexpected here is the CRM's side
         (Directus, network), and the request is safe to retry as-is. */
      logger.error({ err: (err as Error)?.message }, 'yiji inbound: unexpected failure');
      return reply.code(503).send(unavailable().toBody());
    }
  };

  void app.register(
    async (scope) => {
      /* Live answers about one customer's ticket: never cached by a CDN. */
      scope.addHook('onSend', async (_req, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
      });
      /* An unparseable body is the caller's mistake: 400, not Fastify's 500. */
      scope.setErrorHandler(async (err, _req, reply) => {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 415) {
          return reply.code(415).send({
            error: 'invalid_request',
            message: 'Send Content-Type: application/json.',
          });
        }
        if (err instanceof SyntaxError || (status && status >= 400 && status < 500)) {
          return reply
            .code(status ?? 400)
            .send({ error: 'invalid_request', message: 'The body must be valid JSON.' });
        }
        logger.error({ err: (err as Error)?.message }, 'yiji inbound: request failed');
        return reply.code(503).send(unavailable().toBody());
      });

      scope.post('/tickets', async (req, reply) => {
        if (!(await guard(req, reply))) return reply;
        return answer(reply, () => deps.service.createTicket(req.body));
      });

      scope.post<{ Params: { externalId: string } }>(
        '/tickets/:externalId/coupons',
        async (req, reply) => {
          if (!(await guard(req, reply))) return reply;
          return answer(reply, () => deps.service.addCoupon(req.params.externalId, req.body));
        },
      );

      scope.get<{ Params: { externalId: string } }>('/tickets/:externalId', async (req, reply) => {
        if (!(await guard(req, reply))) return reply;
        return answer(reply, () => deps.service.readTicket(req.params.externalId));
      });
    },
    { prefix: YIJI_INBOUND_PREFIX },
  );
}
