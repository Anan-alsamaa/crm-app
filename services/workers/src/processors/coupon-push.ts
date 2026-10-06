import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItem, readItems, updateItem } from '@directus/sdk';
import type {
  CouponOrderContext,
  CouponPushJob,
  YijiAdminPoster,
  YijiCustomerFinder,
  YijiOrderReader,
} from '@yiji/shared-types';
import {
  couponWindow,
  isPercentageCategory,
  internationalPhone,
  isPhoneDerivedCustomerId,
  isYijiRefused,
  isYijiUnavailable,
  yijiCouponEnum,
  yijiDeliveryTypes,
  yijiIssuingSideId,
  YIJI_ORDER_MAXIMUM,
  YIJI_REACH_LIMIT,
  YIJI_COUPON_CATEGORY,
  YIJI_COUPON_TYPE,
} from '@yiji/shared-types';
import { couponOrderId } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { describeError } from '../lib/errors.js';

/**
 * Tell Yiji about a coupon a supervisor approved.
 *
 * Yiji owns the coupon that the customer can actually redeem; the CRM owns the
 * decision to grant one. This carries the second to the first, and moves the
 * request from `approved` to `assigned` once Yiji has it — which is exactly
 * what those two states have always meant.
 *
 * A job, not an inline call from the approval, because Yiji being down must
 * never make a supervisor's approval fail. The decision is recorded the moment
 * they make it and this delivers it afterwards, with retries.
 *
 * The job carries only an id: the coupon is re-read here, so terms amended by
 * the supervisor cannot be pushed as the agent originally asked for them, and a
 * request reversed between queueing and delivery is dropped rather than sent.
 */

/**
 * The path on Yiji's ADMIN API that grants a coupon against an order.
 *
 * A constant, not configuration: the payload in this file is shaped to THIS
 * endpoint, so a deployment that pointed it elsewhere would be sending a body
 * the other endpoint never agreed to. What IS configurable is whether the
 * service credential exists at all — see `postCoupon`.
 */
export const YIJI_COUPON_PATH = '/api/CouponUserOrder/CreateCouponUserFromOrder';

/**
 * The path that grants a coupon to a USER, with no order involved.
 *
 * Verified against the live Swagger and admin API (2026-10-01). It takes a
 * `CouponUserVM` — `userId`, `couponCode`, `compensationReason`, the coupon
 * terms — and its `orderId` is explicitly NULLABLE, which is the whole
 * difference from `CreateCouponUserFromOrder` above, whose `CouponUserOrderVM`
 * requires one.
 *
 * WHY A SECOND PATH RATHER THAN A LOOSER FIRST ONE: the order-based endpoint
 * resolves the customer FROM the order, so it genuinely cannot work without
 * one. This endpoint resolves them from `userId` instead. Two different
 * questions, two different bodies — the same reason the path and payload are
 * declared together here.
 *
 * `AddUserCoupon`, NOT `AddCompensationCoupon`. The latter is the obvious pick
 * by name and takes the identical `CouponUserVM`, but our account is 403 on it
 * — see the constant below for the measurements and why chasing that grant is
 * the wrong move.
 *
 * This corrects a comment this file used to carry, that Yiji "cannot attach a
 * coupon without an order". It can; it just needs to be told who the customer
 * is. See [[yiji-coupon-without-order]].
 */
export const YIJI_COMPENSATION_COUPON_PATH = '/api/CouponUser/AddUserCoupon';

/**
 * `AddCoupon` answers with the new id in `exceptionMessage`, not in a field.
 *
 *     { "result": 1, "exceptionMessage": "couponId 73900", "extendedProperties": {} }
 *
 * `extendedProperties` is EMPTY here — unlike every other coupon call, where
 * `CouponUserId` lives in it. Confirmed twice against the live API. So the id
 * is dug out of the message, and `result` is still what decides success.
 */
export function readNewCouponId(body: YijiCouponResponse): number | null {
  if (body?.result !== 1) return null;
  const m = /(\d+)/.exec(String(body?.exceptionMessage ?? ''));
  const id = m ? Number.parseInt(m[1]!, 10) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * The endpoint this USED to call, kept named so the reason is not lost.
 *
 * `AddCompensationCoupon` is the obvious choice by name and takes the very
 * same `CouponUserVM` — but our service account is **403 Forbidden** on it,
 * while `AddUserCoupon` beside it answers 400 to the same probe. Measured
 * against the live admin API, same token, same second:
 *
 *     POST /api/CouponUser/AddCompensationCoupon   403   FORBIDDEN
 *     POST /api/CouponUser/AddUserCoupon           400   reachable
 *     POST /api/Coupon/AddCoupon                   400   reachable
 *     GET  /api/CouponUser/GetAllUserCoupons       403   FORBIDDEN
 *     GET  /api/Coupon/GetAllCoupons               403   FORBIDDEN
 *
 * The CRM token carries the role claim `agent 1`, not an admin role, and the
 * 403s cluster on the endpoints an agent is not trusted with. This is NOT one
 * missing grant to chase — it is what that role is allowed to do, and
 * `AddUserCoupon` is the one inside it that does exactly what we need.
 */
export const YIJI_COMPENSATION_COUPON_PATH_FORBIDDEN = '/api/CouponUser/AddCompensationCoupon';

/**
 * Create a coupon that belongs to NOBODY YET, redeemable by its code.
 *
 * THE CASE THIS EXISTS FOR (owner, 2026-10-02): the customer complained over
 * WhatsApp and has no Yiji account at all, so there is no `userId` to grant to
 * and no order to attach to. Both other paths are impossible by definition, and
 * the compensation was simply never delivered.
 *
 * This creates the coupon ON Yiji, unassigned — `CouponVM.assignee` is nullable
 * and no user is named — carrying OUR code. The agent then sends the customer
 * the code, the app link and how to redeem; when they install and enter it,
 * Yiji attaches it to the account they just made (their own
 * `AddCouponToUserByCode` is the other half of that).
 *
 * WHY THIS PATH AND NOT THE OTHER TWO. Measured against the live admin API on
 * 2026-10-02 with our service credential:
 *
 *     POST /api/Coupon/AddCoupon                      400  reachable
 *     POST /api/CouponUser/AddCouponToUserByCode/..   200  reachable
 *     POST /api/CouponUser/AddCompensationCoupon      403  FORBIDDEN
 *     POST /api/CouponUserOrder/CreateCouponUserFromOrder  400  reachable
 *
 * (400 = the endpoint rejected a deliberately empty probe body, which proves
 * permission; 403 = no permission at all. Nothing was created by the probe.)
 *
 * So the account that cannot grant a coupon directly to a user CAN create an
 * unassigned one — which is why this fallback is usable today while
 * `AddCompensationCoupon` is still refused.
 */
export const YIJI_UNASSIGNED_COUPON_PATH = '/api/Coupon/AddCoupon';

/**
 * WHICH PLATFORM GRANTS THE COUPON, KEYED BY VENDOR.
 *
 * One entry today, and deliberately so: Yiji is the only platform that issues
 * coupons, and its behaviour here is unchanged — same path, same payload, same
 * rules, same tests. This exists so the SECOND platform is a row rather than a
 * rewrite of the money path.
 *
 * The path and the payload belong together and are declared together. They are
 * not separately configurable, because a deployment that pointed this path
 * somewhere else would be sending a body the other endpoint never agreed to —
 * the reason the constant above is a constant.
 *
 * `vendorId` is the id the CRM already carries on every vendor row and inside
 * every customer token, so nothing new has to be threaded through to reach it.
 * An unknown vendor resolves to `null` and the push is skipped rather than
 * guessed: sending a coupon to the wrong platform is worse than not sending it.
 */
export interface CouponEndpoint {
  /** The vendor's own path on their admin API. */
  path: string;
  /** Human name, for logs that somebody has to read at 2am. */
  platform: string;
}

const COUPON_ENDPOINTS: Record<string, CouponEndpoint> = {
  // Yiji / EG. `'1'` is DEFAULT_VENDOR_ID — the value the app sends and the
  // value a token carries when none was supplied.
  '1': { path: YIJI_COUPON_PATH, platform: 'yiji' },
};

/**
 * The coupon endpoint for a vendor, or null when that vendor does not issue
 * coupons through us.
 *
 * Falls back to vendor `'1'` when no vendor is recorded, which is every row
 * written before vendors were distinguished. That fallback is correct only
 * while Yiji is the sole platform — the day a second one exists it must be
 * removed, or somebody else's coupons quietly become Yiji's.
 */
export function couponEndpointFor(vendorId: string | null | undefined): CouponEndpoint | null {
  const key = (vendorId ?? '').trim() || '1';
  return COUPON_ENDPOINTS[key] ?? null;
}

export interface CouponPushDeps {
  directus: YijiDirectusClient;
  logger: Logger;
  /**
   * Sends the coupon to Yiji, signed in as the service account.
   *
   * ABSENT MEANS DELIVERY IS NOT CONFIGURED, and the request stays `approved`.
   * Deliberately not treated as success: marking it `assigned` would tell every
   * report that Yiji holds a coupon it has never heard of, and the difference
   * between those two states is the only record of whether the customer can
   * actually redeem anything.
   *
   * Injected rather than built here so the credential handling lives in one
   * place (`createYijiAdminPoster`) alongside the status-history integration
   * that talks to the same host — and so this processor never holds a secret.
   */
  postCoupon?: YijiAdminPoster;
  /**
   * Reads Yiji's own record of the order, for the customer id, their phone
   * formatting and their brand/restaurant ids — see `yijiCouponPayload`.
   *
   * Optional, and a failure here never blocks delivery: the order id alone is
   * enough for the endpoint to resolve the customer, so a coupon still goes
   * with less corroboration rather than not at all.
   */
  readOrder?: YijiOrderReader;
  /**
   * Finds the Yiji customer behind a phone number, for a coupon with NO order.
   *
   * Absent means the order-less path is simply unavailable and such a coupon
   * stays `approved` as before — the same shape as `postCoupon` being absent.
   * Never used when an order exists: that path resolves the customer itself and
   * needs no lookup.
   */
  findCustomer?: YijiCustomerFinder;
  /**
   * Yiji's `tenantid` header. Their API is multi-tenant and mis-routes a call
   * without it; the captured request sends `1`.
   */
  yijiTenantId: string;
  /**
   * STAGING ONLY. Redirect every coupon to this one handset.
   *
   * Staging shares Yiji's PRODUCTION coupon API, so a test coupon otherwise
   * lands on a real stranger and cannot be revoked from our side. Empty in
   * production, and `assertCouponRedirectSafe` refuses the combination of a
   * redirect and a production environment outright rather than trusting that.
   */
  redirectCouponsTo?: string;
}

export interface CouponApprovalRow {
  id: string;
  status: string | null;
  coupon_code: string | null;
  coupon_value: number | string | null;
  coupon_percent: number | string | null;
  max_discount: number | string | null;
  usage_limit: number | string | null;
  valid_from: string | null;
  valid_to: string | null;
  title: string | null;
  issuing_side: string | null;
  delivery_type: string | null;
  coupon_type: string | null;
  discount_category: string | null;
  brand_id: string | null;
  restaurant_id: string | null;
  item_name: string | null;
  /**
   * One CRM answer driving Yiji's `dontApplyLoyality` AND `dontApplyOffer`,
   * which always move together. True = cannot be used on an already-discounted
   * item. Null on rows written before the field existed, and `=== true` below
   * treats that as false — the permissive reading.
   */
  no_other_discounts: boolean | null;
  reason: string | null;
  /**
   * The customer's number when no contact row stands behind the request.
   *
   * A late-order or WhatsApp compensation has neither a ticket nor a contact,
   * so this is the only phone on the row — and on the order-less path it is how
   * the customer is found on Yiji.
   */
  customer_phone?: string | null;
  contact: {
    /** Needed to write the Yiji id back when the order reveals it. */
    id: string;
    name: string | null;
    phone: string | null;
    /** The customer's id in YIJI — what their API calls `userId`. */
    external_customer_id: string | null;
  } | null;
  /**
   * The ticket the coupon compensates, for its ORDER.
   *
   * `CreateCouponUserFromOrder` attaches a coupon to one order — which is
   * exactly the shape this business wants: a coupon is granted because a
   * specific order went wrong. No order, no call.
   *
   * OPTIONAL since 2026-09-21. A coupon given from the late-orders queue has
   * no complaint behind it, so it carries `order_id` itself; `couponOrderId`
   * reads whichever is present, preferring the ticket's.
   */
  ticket: { order_id: string | null } | null;
  /** The order, when this coupon was raised without a ticket. */
  order_id?: string | null;
  yiji_coupon_user_id: string | null;
  /** Why the last delivery attempt did not land. Null once it does. */
  yiji_push_error?: string | null;
  /**
   * Never ASSIGN this one to the customer — the refund customer who will not
   * accept an app coupon. Since 2026-10-06 it is still CREATED on Yiji,
   * unassigned (owner); see `createWithheldCoupon`.
   */
  delivery_excluded?: boolean | null;
  /**
   * Yiji's COUPON id for a withheld coupon created unassigned.
   *
   * Its own column, deliberately not `yiji_coupon_user_id`: that one means
   * "a customer holds this", and overloading it once already confused which
   * coupons had actually reached somebody (owner, 2026-10-06). Also the
   * idempotency evidence — set means never create again.
   */
  yiji_coupon_id?: string | null;
}

/** Postgres returns `numeric` as a string; Yiji is sent numbers. */
function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * THE COUPON'S NAME ON YIJI: THE CUSTOMER'S OWN NUMBER, `+9665XXXXXXXX`.
 *
 * Operations name every compensation coupon this way in Yiji's own console —
 * Title `+966546888669`, the reason in the separate "compensation" field — and
 * asked for ours to match (owner, 2026-10-05). We were sending the REASON as
 * the name, so their coupon list read as a column of complaint sentences
 * instead of the customer each one belongs to, and could not be searched by
 * number the way their own coupons are.
 *
 * The reason is NOT lost: it travels in `compensationReason` and
 * `compensation`, which is where their console shows it.
 *
 * THIS REVERSES 2026-10-03, deliberately. That change took the phone OUT of
 * the name after customers saw bare `(05…)` numbers in their wallet and read
 * them as somebody else's coupons. The number is now always the RECEIVING
 * customer's own — the same one Yiji is sent as `customerPhone` — and in the
 * `+966` form their console uses, never a stranger's.
 *
 * With no number at all (rare: a coupon with neither an order nor a phone), a
 * title the agent typed is kept, else a plain label. Never the reason: that is
 * the field this exists to stop overloading.
 */
export function customerFacingCouponName(
  phone: string | null | undefined,
  title: string | null | undefined,
): string {
  const p = (phone ?? '').trim();
  if (p) return internationalPhone(p) ?? p;
  const t = (title ?? '').trim();
  /* A title that is itself a number is the same fact in our `05…` shape. */
  if (/^\+?[\d\s()-]{8,}$/.test(t)) return internationalPhone(t) ?? t;
  return t || 'Compensation';
}

/** The marker every CRM-created coupon's description starts with. */
export const CRM_COUPON_PREFIX = 'CRM - ';

/**
 * THE COUPON'S DESCRIPTION ON YIJI, MARKED AS OURS.
 *
 * Operations cannot tell a coupon the CRM created from one somebody built by
 * hand in Yiji's admin portal — both carry a `+9665…` name and a free-text
 * reason. So every coupon we create (assigned OR withheld) starts its
 * description with "CRM - " (owner, 2026-10-06).
 *
 * The description, not the name: the name stays the customer's number, per
 * the owner's 2026-10-05 rule, so their console can still be searched by it.
 *
 * Never doubled — a reason an agent already typed as "CRM - …" (or a retry
 * that re-reads a prefixed value) keeps exactly one marker. An empty reason
 * still says whose coupon it is rather than leaving a bare "CRM - ".
 */
export function crmCouponDescription(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if (!r) return `${CRM_COUPON_PREFIX}Compensation`;
  if (/^crm\s*-\s*/i.test(r)) return r;
  return `${CRM_COUPON_PREFIX}${r}`;
}

/**
 * The body Yiji receives, shaped to `CreateCouponUserFromOrder`.
 *
 * The field names come from Yiji's own schema and from a captured request that
 * returned `result: 1`. The endpoint attaches a coupon to ONE ORDER, which is
 * exactly what this business grants — a coupon because a specific order went
 * wrong.
 *
 * THE ORDER IS THE KEY, and it is also the SOURCE. Yiji's own record of the
 * order carries the customer id, the customer's phone in their formatting, and
 * their numeric brand and restaurant ids — all read back before this is built
 * (see `CouponOrderContext`). Preferring their values over ours is not
 * politeness, it is the difference between a field that matches and one that
 * merely looks filled in:
 *
 *   userId        their GUID. We could not otherwise obtain it — their API has
 *                 no lookup by phone — and 0 of 13 approvals here carried one.
 *                 It was sitting on the order the whole time.
 *   customerPhone `+9665XXXXXXXX`, confirmed by reading a real order back. We
 *                 store `05…` because that is what people say and type, so it
 *                 is converted rather than sent as we hold it.
 *   restaurantId  numbers in THEIR namespace (107, 1). Ours are "store-4" and
 *                 "Casa Pasta", which is why they used to be omitted entirely.
 *   brandId       Sending a wrong number here would scope the coupon to
 *                 somebody else's branch, so it is sent only when it came FROM
 *                 the order.
 *
 * `couponId: 0` because we are not redeeming a catalogue entry Yiji already
 * holds; we are asking it to create a compensation coupon. The TERMS the
 * supervisor approved therefore travel under `couponUser.coupon`, or a
 * supervisor approves 25 SAR and the customer receives whatever their default
 * happens to be.
 */
export function yijiCouponPayload(
  row: CouponApprovalRow,
  /**
   * Yiji's own record of the order. Absent when the lookup failed or is not
   * configured — the push still goes, because the order id alone is enough for
   * the endpoint to resolve the customer; it just carries less corroboration.
   */
  order?: CouponOrderContext | null,
  opts?: {
    /** Staging safety: send every coupon to one test handset. Empty in prod. */
    redirectCouponsTo?: string;
    /**
     * The Yiji customer id, for a coupon with NO order.
     *
     * Present only on the `AddCompensationCoupon` path, where nothing else can
     * identify the customer: the order-based endpoint derives them from the
     * order and is sent no `userId` at all. Setting this changes the RETURNED
     * SHAPE to that endpoint's `CouponUserVM` — see the return below.
     */
    compensationUserId?: string;
    /**
     * Build the body for `AddCoupon`: a coupon belonging to NOBODY, redeemable
     * by its code. For a customer with no Yiji account, where there is neither
     * an order to attach to nor a user to grant to.
     */
    unassigned?: boolean;
    /**
     * Build the body for `AddCoupon` for a WITHHELD coupon: created on Yiji,
     * Private, assigned to nobody (owner, 2026-10-06). Every term is the
     * ASSIGNED coupon's — see the return below.
     */
    withheld?: boolean;
  },
): Record<string, unknown> {
  const orderId = num(couponOrderId(row));
  const window = row.valid_from && row.valid_to ? couponWindow(row.valid_from, row.valid_to) : null;
  const amount = num(row.coupon_value);
  const percent = num(row.coupon_percent);
  const cap = num(row.max_discount);
  const limit = num(row.usage_limit) ?? 1;
  const deliveryTypes = yijiDeliveryTypes(row.delivery_type);
  /* Which of the two money fields is authoritative — see the discount pair. */
  const isPct = isPercentageCategory(row.discount_category);

  /*
   * Their id first, ours only if it is genuinely theirs.
   *
   * `external_customer_id` is null for every walk-in and was, for a while,
   * filled with a `cust-<digits>` handle our own gateway minted — which is why
   * this refuses anything phone-derived rather than trusting the column.
   */
  const stored = row.contact?.external_customer_id?.trim();
  const realUserId =
    order?.userId ?? (stored && !isPhoneDerivedCustomerId(stored) ? stored : undefined);

  // Theirs verbatim — it is already in their format — else ours, converted.
  const realPhone = order?.customerPhone ?? internationalPhone(row.contact?.phone) ?? undefined;

  /*
   * STAGING ONLY: every coupon goes to ONE test handset.
   *
   * Staging shares Yiji's PRODUCTION coupon API — there is no test instance —
   * so a coupon raised while testing lands on a real stranger's account and
   * cannot be revoked from our side. Redirecting them all to the owner's own
   * number makes staging safe to exercise end to end (owner, 2026-09-22).
   *
   * The user id is dropped along with the phone. Keeping it would send Yiji a
   * matched pair naming two different people, and their endpoint resolves the
   * customer from whichever it trusts — which is exactly the coin-toss this
   * exists to remove.
   *
   * `redirectCouponsTo` is empty in production. It is read from config rather
   * than NODE_ENV so that a misconfigured production cannot silently redirect
   * real customers' coupons to a test phone — an empty value is the only
   * default, and `assertNotProduction` below refuses the combination outright.
   */
  const redirect = opts?.redirectCouponsTo?.trim();
  /*
   * ON THE ORDER-LESS PATH THE USER ID IS THE ONLY IDENTIFIER, so it survives
   * the staging redirect that otherwise drops it.
   *
   * That is not a hole in the redirect, it is the redirect working: the caller
   * looks up `redirectCouponsTo` itself on staging, so this id already belongs
   * to the TEST handset. Dropping it would leave Yiji a body naming nobody,
   * which `AddCompensationCoupon` cannot act on — the order-based endpoint can,
   * because the order names the customer for it.
   */
  const yijiUserId = opts?.compensationUserId ?? (redirect ? undefined : realUserId);
  const phone = redirect ? (internationalPhone(redirect) ?? redirect) : realPhone;
  /* Named after whoever RECEIVES it — on staging that is the test handset, so
     the name and the recipient can never disagree. */
  const couponName = customerFacingCouponName(
    phone ?? (redirect ? undefined : row.customer_phone),
    row.title,
  );
  /* "CRM - <reason>" everywhere the reason travels (owner, 2026-10-06). */
  const description = crmCouponDescription(row.reason);

  /*
   * ONE `CouponUserVM`, TWO ENVELOPES.
   *
   * This object IS the body `AddCompensationCoupon` takes, and it is also the
   * `couponUser` the order-based endpoint nests. Building it once is what keeps
   * the two paths honest: the terms a supervisor approved cannot differ by
   * whether an order happened to be attached.
   */
  const couponUser = {
    id: 0,
    // Yiji creates the coupon; we are not naming one it already holds.
    couponId: 0,
    orderId,
    status: 0,
    // OUR code, so the two systems can be matched from either side later.
    couponCode: row.coupon_code ?? '',
    couponName,
    compensationReason: description,
    ...(yijiUserId ? { userId: yijiUserId } : {}),
    ...(phone ? { customerPhone: phone } : {}),
    // Ours is often blank and theirs is a generated address; prefer whichever
    // a human would recognise, and send nothing rather than an empty string.
    ...(row.contact?.name?.trim() || order?.customerName
      ? { customerName: row.contact?.name?.trim() || order?.customerName }
      : {}),
    // The terms the supervisor approved. Only one of amount/percentage is
    // ever set — the discount category decides which — so the other is left
    // off rather than sent as zero, which would read as "no discount".
    coupon: {
      id: 0,
      name: couponName,
      code: row.coupon_code ?? '',
      compensationReason: description,
      /*
       * The reason, AGAIN, under the name their console uses.
       *
       * Their request carries `compensation: "testing"` on the coupon while
       * ALSO carrying `compensationReason` on the couponUser — the same text
       * in two places. `compensation` is not in the published CouponVM
       * schema, so it is an extra their own UI sends; harmless if ignored,
       * and the alternative is a field their reporting may read sitting
       * empty on every coupon we create.
       */
      compensation: description,
      /*
       * WHAT KIND of coupon this is.
       *
       * Sent because it used to not be. Yiji defaults both of these to 0 —
       * General and Percentage — so a coupon the supervisor approved as
       * Private/Amount arrived in Yiji as General/Percentage. The MONEY was
       * always right (`discount`/`maximumDiscount` below), which is why this
       * went unnoticed: the customer got the correct amount off a coupon
       * described as something else entirely.
       *
       * Omitted rather than defaulted when the CRM word is not in the map:
       * 0 means something in both vocabularies, so sending it as a fallback
       * would assert the opposite of what was approved.
       */
      ...(yijiCouponEnum(YIJI_COUPON_TYPE, row.coupon_type) != null
        ? { type: yijiCouponEnum(YIJI_COUPON_TYPE, row.coupon_type) }
        : {}),
      ...(yijiCouponEnum(YIJI_COUPON_CATEGORY, row.discount_category) != null
        ? { category: yijiCouponEnum(YIJI_COUPON_CATEGORY, row.discount_category) }
        : {}),
      /*
       * BOTH discount fields, always — the unused one as 0, never omitted.
       *
       * Their own working AMOUNT coupon (70644) carries
       * `discount: 5, discountPercentage: 0`. It states the irrelevant one
       * rather than leaving it out, and we were omitting it entirely. A
       * validator that reads `discountPercentage` unconditionally sees null
       * where it expects a number, and null is not 0 in any arithmetic that
       * matters — it is the difference between "no percentage discount" and
       * "unknown", and the second can nullify a calculation.
       *
       * `category` already says which one is authoritative, so stating both
       * cannot make the coupon ambiguous. This is cheap insurance against a
       * class of failure that is invisible from our side: the coupon exists,
       * the customer is notified, and nothing is redeemable.
       */
      /*
       * THE CATEGORY DECIDES, and the other field is forced to 0.
       *
       * These used to be `amount ?? 0` and `percent ?? 0` independently,
       * which is right whenever exactly one column is set — and wrong when
       * both are. An agent who types an amount, switches the category to
       * Percentage and types a percentage leaves BOTH columns populated, and
       * we would then send `discount: 25, discountPercentage: 15` on a coupon
       * approved as one or the other. Yiji would be free to apply either.
       *
       * `category` is already the authority on which reading is correct — it
       * is sent immediately above — so deriving both values from it is the
       * only way the three can never contradict each other. Confirmed against
       * two real coupons: an Amount coupon carries `discount: N,
       * discountPercentage: 0`, and both fields are always present.
       */
      discount: isPct ? 0 : (amount ?? 0),
      discountPercentage: isPct ? (percent ?? 0) : 0,
      ...(cap != null ? { maximumDiscount: cap } : {}),
      /*
       * HOW MANY TIMES IT MAY BE USED — MATCHED TO YIJI'S OWN CONSOLE.
       *
       * Their console's payload for a working coupon, captured by the owner
       * (2026-10-03), ends the guesswork:
       *
       *     reachLimit:        1002      <- a POOL, deliberately far above
       *     monthlyReachLimit: 3         <- what one customer may use
       *     limitForUser:      (absent)  <- not a field they send AT ALL
       *
       * `reachLimit` is the total across every holder of the coupon, and Yiji
       * sets it an order of magnitude above the per-customer figure precisely
       * so it never binds. We were sending `reachLimit: 1`, so the pool was
       * exhausted by the first grant and the customer was refused at checkout
       * with "Coupon exceeds usage limit" — on all 102 coupons issued.
       *
       * `limitForUser` was ours, not theirs. It is kept because it is harmless
       * and may be read, but it is no longer the only thing stating the
       * per-customer allowance: `monthlyReachLimit` is the field their own
       * console uses for that, and it carries the CRM's "Number of uses" box.
       *
       * The pool is derived rather than asked for — nobody wants a second
       * number — and it is generous on purpose: the CRM creates one coupon per
       * customer, so a pool that binds before the allowance does is always a
       * bug, never a policy.
       */
      /*
       * THE POOL. Generous for an ASSIGNED coupon, which belongs to one named
       * customer — `monthlyReachLimit` is what bounds them, and a pool that
       * runs out first is the bug this fixes.
       *
       * TIGHT for an UNASSIGNED one. That coupon has no customer: its code
       * goes to somebody over WhatsApp and anyone who learns it can spend it.
       * The pool is the ONLY bound there, so it is exactly the allowance.
       */
      /*
       * FIXED, ON EVERY COUPON (owner, 2026-10-06): "orderMaximum and
       * reachLimit are fixed and never change until I ask" — no exception for
       * unassigned coupons, no deriving from the uses. A derived reachLimit is
       * exactly what left 88 coupons unredeemable.
       */
      reachLimit: YIJI_REACH_LIMIT,
      limitForUser: limit,
      monthlyReachLimit: limit,
      /*
       * The order-value window this coupon may be applied to.
       *
       * `orderMaximum` was NOT being sent, so Yiji defaulted it to 0 — a
       * ceiling of zero, meaning the coupon could never apply to any order.
       * That is why a customer got the notification and then found nothing in
       * the app: the grant existed and was unusable.
       *
       * `orderMinimum: 0` is sent explicitly rather than left to default, so
       * both ends of the window are stated. 0 on a FLOOR is permissive (no
       * minimum spend); 0 on a CEILING is not. See YIJI_ORDER_MAXIMUM.
       */
      orderMinimum: 0,
      orderMaximum: YIJI_ORDER_MAXIMUM,
      /*
       * FIELDS YIJI'S OWN CONSOLE SENDS AND WE DID NOT.
       *
       * Taken from a coupon built by hand in their console against the same
       * order and customer as ours (CouponUserId 21486). Each of these was
       * absent from our request and therefore defaulted — and this API has
       * already shown twice that its defaults are not the generous reading
       * (`orderMaximum: 0` is a ceiling of zero; `deliveryTypes: []` is not
       * "any channel").
       *
       * `dontApplyLoyality` / `dontApplyOffer` ALWAYS MOVE TOGETHER (owner,
       * 2026-08-29) — one CRM answer drives both. True means the customer
       * cannot use this coupon on an item that already carries a discount;
       * false means it stacks on top.
       *
       * Both were briefly hardcoded `true` here, copied from a console
       * coupon. That was the console's choice for one test coupon, not a rule
       * — and hardcoding it would have quietly made every apology unusable
       * during a promotion. It is a decision the agent raising the coupon
       * should make, so it is now `no_other_discounts` on the request.
       *
       * `posDisountCode: 0` is what they send; stated rather than left to
       * default so the payload is identical to one that works.
       */
      dontApplyLoyality: row.no_other_discounts === true,
      dontApplyOffer: row.no_other_discounts === true,
      posDisountCode: 0,
      /*
       * WHO PAYS FOR THIS COUPON.
       *
       * Sent only when the CRM issuing side has a known Yiji id — see
       * ISSUING_SIDES, where every id is currently null and therefore
       * nothing is sent yet. Omitting it leaves Yiji to default, which is
       * what happens today; sending a GUESSED id would silently book real
       * money to the wrong department in their reporting and never announce
       * itself. Fill the ids in that one table and this starts working with
       * no change here.
       */
      ...(yijiIssuingSideId(row.issuing_side) != null
        ? { issuingSideId: yijiIssuingSideId(row.issuing_side) }
        : {}),
      /*
       * Which channels it may be redeemed through.
       *
       * Omitted entirely for "All" and for anything unrecognised — an empty
       * `deliveryTypes` is Yiji's own spelling of "no restriction", so the
       * unrestricted case is correct by saying nothing, and a partial list
       * would silently narrow a coupon to fewer channels than were approved.
       * See `yijiDeliveryTypes`, which also carries the caveat that the
       * NUMBERING is inferred rather than confirmed.
       */
      ...(deliveryTypes ? { deliveryTypes } : {}),
      /*
       * Every day of the week.
       *
       * Yiji carries a per-weekday flag and defaults them all to FALSE. A
       * correctly-built coupon in their console (70644) has all seven true;
       * ours (70640) had all seven false. Nobody has reported a coupon being
       * refused on a given day, so this may be inert for compensation
       * coupons — but "valid on no day of the week" is not a thing anyone
       * approved, and matching a known-good coupon is the safer default.
       *
       * A compensation coupon is an apology; restricting it to certain days
       * is not a decision the CRM offers, so all seven is the honest encoding
       * of "whenever they like".
       */
      saturday: true,
      sunday: true,
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      // Only ever THEIR ids, and only when the order supplied them.
      ...(order?.restaurantId != null ? { restaurantId: order.restaurantId } : {}),
      ...(order?.brandId != null ? { brandId: order.brandId } : {}),
      ...(window
        ? {
            activationDate: window.from,
            expirationDate: window.to,
            activationDateTime: window.from,
            expirationDateTime: window.to,
          }
        : {}),
    },
  };

  /*
   * THE ORDER-LESS BODY IS THE INNER OBJECT ITSELF.
   *
   * `AddCompensationCoupon` takes a `CouponUserVM`; `CreateCouponUserFromOrder`
   * takes a `CouponUserOrderVM` that WRAPS one. Sending the wrapper to the
   * compensation endpoint would hand it a body it never agreed to, with the
   * customer and the terms buried a level too deep — it would answer 200 and
   * grant nothing, which is the failure shape this file exists to prevent.
   */
  if (opts?.compensationUserId) return couponUser;

  /*
   * THE WITHHELD BODY: THE ASSIGNED COUPON, VERBATIM, MINUS ITS OWNER.
   *
   * A coupon the agent or supervisor marked "do not send to the customer on
   * the Yiji app" — the refund customer — must still EXIST on Yiji, recorded
   * and accounted for, but belong to nobody (owner, 2026-10-06).
   *
   * Private (1) with `assignee: []`, which is exactly that: Private means only
   * an assignee may use it, and there is none. The opposite of the unassigned
   * path below, which goes General precisely so a stranger CAN redeem it by
   * code — this one must be redeemable by no one.
   *
   * Every OTHER field is the assigned coupon's own object, unmodified — the
   * same reachLimit (10000, NOT the unassigned path's tight pool), the same
   * orderMaximum, name, dates and flags. The owner's warning is why: "ensure
   * all values are proper as we faced a big issue before" (reachLimit 1 made
   * 88 coupons unusable). Building it from the same object is what makes a
   * drift impossible, and a test pins the equality field by field.
   */
  if (opts?.withheld) {
    return {
      /* The coupon type is the one the AGENT selected — never overridden
         (owner, 2026-10-06). Only the assignee is empty. */
      ...(couponUser.coupon as Record<string, unknown>),
      assignee: [],
    };
  }

  /*
   * THE UNASSIGNED BODY IS THE `coupon` OBJECT, ON ITS OWN.
   *
   * `AddCoupon` takes a `CouponVM` — the very object nested at
   * `couponUser.coupon` above. Reusing it is the point: every field in there
   * was learned the hard way (see docs/YIJI-COUPON-NOT-VISIBLE.md, where five
   * omissions each produced a coupon that existed, notified the customer and
   * could not be used, because in this API an absent field is NOT a neutral
   * default — zero on a ceiling means zero). Rebuilding it here would be
   * rediscovering all five.
   *
   * `type: 0` (General/Public), not Private. A private coupon is bound to a
   * person, and this one has no person yet — that is the whole case. It also
   * happens to be the type the mobile app can list: `GetAllGeneralCoupon` is
   * the only coupon-listing endpoint the app has.
   *
   * Nothing names a customer: no `userId`, no `customerPhone`, no `assignee`.
   * That is what makes it redeemable by whoever enters the code — which is why
   * the caller caps it at one use.
   */
  if (opts?.unassigned) {
    return {
      /* The coupon type is the one the AGENT selected — no longer forced to
         General (owner, 2026-10-06: "the coupon type should always be the
         value the agent selects"). */
      ...(couponUser.coupon as Record<string, unknown>),
      assignee: [],
    };
  }

  return {
    id: 0,
    orderId,
    usedAmount: 0,
    status: 0,
    couponUser,
  };
}

/**
 * Yiji answers 200 even when it refused.
 *
 * The body carries the verdict: `result: 1` with the new id in
 * `extendedProperties.CouponUserId`. A failure is a 200 with a different
 * `result` and a message in `exceptionMessage`. Reading only the HTTP status
 * would mark a refused coupon as assigned and tell every report the customer
 * can redeem something they cannot — the exact shape of silent failure this
 * codebase keeps finding.
 */
export interface YijiCouponResponse {
  result?: number;
  exceptionMessage?: string | null;
  errorCode?: string | null;
  errorMessages?: Record<string, unknown> | null;
  extendedProperties?: { CouponUserId?: number | string } | null;
  transactionStatus?: number;
}

/** The new CouponUserId, or a reason it is not there. */
export function readCouponUserId(body: YijiCouponResponse): {
  ok: boolean;
  couponUserId?: string;
  error?: string;
} {
  if (body?.result !== 1) {
    const detail =
      body?.exceptionMessage && body.exceptionMessage !== '0'
        ? body.exceptionMessage
        : JSON.stringify(body?.errorMessages ?? body?.errorCode ?? body?.result ?? 'no result');
    return { ok: false, error: `yiji refused the coupon: ${detail}` };
  }
  const id = body?.extendedProperties?.CouponUserId;
  // `result: 1` with no id is a success we cannot evidence. Treated as a
  // failure: "assigned" has to mean there is something on Yiji's side to point
  // at, or the state is worth nothing.
  if (id === undefined || id === null || id === '') {
    return { ok: false, error: 'yiji accepted the coupon but returned no CouponUserId' };
  }
  return { ok: true, couponUserId: String(id) };
}

/**
 * Turn Yiji's refusal body into one line a supervisor can act on.
 *
 * `exceptionMessage` is where they put the human reason; '0' is their idiom for
 * "no message". Everything else falls back to the raw shape rather than a
 * shrug — an unexplained failure on the approval screen is the thing this
 * column exists to prevent.
 */
export function describeRefusal(body: unknown): string {
  const b = body as { exceptionMessage?: string | null; result?: number } | null;
  const msg = b?.exceptionMessage;
  if (typeof msg === 'string' && msg && msg !== '0') return msg.slice(0, 500);
  return JSON.stringify(body ?? 'no body').slice(0, 500);
}

/**
 * Write down why the coupon did not go.
 *
 * Best-effort: if recording the failure ALSO fails there is nothing useful left
 * to do, and throwing here would replace a precise reason with a generic one.
 * The status is untouched — the coupon is still approved and still owed.
 */
async function recordFailure(
  directus: YijiDirectusClient,
  id: string,
  detail: string,
): Promise<void> {
  try {
    await directus.request(
      updateItem('coupon_approvals' as never, id, {
        yiji_push_error: detail,
        yiji_pushed_at: new Date().toISOString(),
      } as never),
    );
  } catch {
    /* the thrown/returned outcome still carries the reason */
  }
}

/** What a push attempt concluded, for the log and the tests. */
export type PushOutcome =
  | 'delivered'
  /**
   * Created on Yiji but belonging to NOBODY yet, because the customer has no
   * app account. The agent sends them the code; redeeming it is what attaches
   * the coupon to the account they then create. Honest as its own outcome: the
   * coupon EXISTS and is spendable, but nobody holds it, so a report must not
   * count it as received.
   */
  | 'unassigned'
  | 'disabled'
  | 'not-approved'
  | 'already-assigned'
  | 'no-order'
  /**
   * Withheld from the customer and CREATED on Yiji, Private and assigned to
   * nobody (owner, 2026-10-06). Recorded in `yiji_coupon_id`; status stays
   * `approved`, because no customer holds it.
   */
  | 'withheld'
  /** Already created as a withheld coupon — never created twice, never assigned. */
  | 'already-withheld'
  /**
   * Yiji answered, and the answer was no — for a reason that will not change
   * by asking again ("User already have this coupon", an order it cannot see).
   *
   * Returned rather than thrown, so BullMQ marks the job done instead of
   * retrying an answer that is settled. The request stays `approved` and the
   * reason is written to `yiji_push_error`, because a coupon that did not
   * arrive is still owed to the customer and a supervisor has to be able to
   * see why without reading a worker log.
   */
  | 'refused';

/**
 * Find approved coupons that have never reached Yiji, and enqueue them.
 *
 * WHY THIS HAS TO EXIST. Delivery is triggered by the supervisor's Approve
 * click, which enqueues one job. That covers everything approved from now on
 * and NOTHING approved before the integration existed — thirteen coupons in
 * this database, already granted to real customers, that no code path would
 * ever have picked up. It also covers the gap the click cannot: the enqueue is
 * deliberately fire-and-forget (a supervisor's decision must not fail because
 * Redis is down), so a coupon can be approved with no job behind it.
 *
 * The selection is the honest definition of "owed but not delivered":
 *   approved or edited, no receipt, and no recorded refusal.
 *
 * The refusal check is what stops this becoming a loop. Yiji answers a settled
 * "no" the same way every time, so a row carrying `yiji_push_error` is left
 * alone until a human clears it — which is what the Retry action on the
 * approval screen does. Without that, every sweep would re-ask a question that
 * has already been answered.
 *
 * Safe to run as often as you like: the job id is per approval, and the push
 * itself re-reads the row and refuses anything already delivered.
 */
export async function runCouponDeliverySweep(deps: {
  directus: YijiDirectusClient;
  logger: Logger;
  couponsQueue: Queue;
}): Promise<number> {
  const { directus, logger, couponsQueue } = deps;
  let rows: Array<{ id: string; coupon_code: string | null }>;
  try {
    rows = (await directus.request(
      readItems(
        'coupon_approvals' as never,
        {
          filter: {
            status: { _in: ['approved', 'edited'] },
            yiji_coupon_user_id: { _null: true },
            yiji_push_error: { _null: true },
            // Withheld rows are never ASSIGNED — they are created unassigned by
            // the separate query below (owner, 2026-10-06).
            delivery_excluded: { _neq: true },
          },
          fields: ['id', 'coupon_code'],
          limit: -1,
        } as never,
      ),
    )) as unknown as Array<{ id: string; coupon_code: string | null }>;
  } catch (err) {
    logger.error(
      // describeError, not `err.message`: a Directus rejection is a plain
      // object, and the usual idiom logs it as "[object Object]" — which is how
      // a missing svc-workers permission on this very collection reported
      // itself as an unexplained failure.
      { err: describeError(err) },
      'could not read undelivered coupons — skipping this sweep',
    );
    return 0;
  }

  /*
   * WITHHELD COUPONS STILL OWED A CREATION ON YIJI (owner, 2026-10-06).
   *
   * A `delivery_excluded` row is never ASSIGNED — the query above keeps it out
   * of that path for good — but it is now created on Yiji once, Private and
   * unassigned. Owed = approved, withheld, no `yiji_coupon_id` yet and no
   * recorded refusal (a duplicate code is recorded there and not re-asked).
   *
   * A SEPARATE query, and a failure here never costs the one above. It names
   * `yiji_coupon_id`, a column that needs a manual `apply:fields`; in Directus a
   * filter on a missing field 403s the WHOLE query, and folding this into the
   * delivery query would let one forgotten bootstrap stop every customer's
   * coupon. Isolated, it costs only the withheld creations until it is applied.
   */
  try {
    const withheld = (await directus.request(
      readItems(
        'coupon_approvals' as never,
        {
          filter: {
            status: { _in: ['approved', 'edited'] },
            delivery_excluded: { _eq: true },
            yiji_coupon_id: { _null: true },
            yiji_push_error: { _null: true },
          },
          fields: ['id', 'coupon_code'],
          limit: -1,
        } as never,
      ),
    )) as unknown as Array<{ id: string; coupon_code: string | null }>;
    /* One job per row even if both queries named it. */
    const seen = new Set(rows.map((r) => r.id));
    rows = [...rows, ...(withheld ?? []).filter((r) => !seen.has(r.id))];
  } catch (err) {
    logger.error(
      { err: describeError(err) },
      'could not read withheld coupons owed a Yiji creation — is coupon_approvals.yiji_coupon_id applied?',
    );
  }

  let queued = 0;
  for (const row of rows) {
    try {
      await couponsQueue.add(
        'push',
        { couponApprovalId: row.id },
        /*
         * NO CUSTOM JOB ID, deliberately.
         *
         * It used to reuse the approval click's id so a coupon already waiting
         * could not be queued twice. That looked careful and made the sweep
         * useless: BullMQ ignores an `add` whose id already exists, and a
         * COMPLETED job keeps its id, so once any push had finished — including
         * one that finished as `disabled` because delivery was off — this
         * silently enqueued nothing for ever after.
         *
         * Duplicate work is not the risk worth guarding here anyway. The
         * processor re-reads the row and stops on a receipt, on a recorded
         * refusal, on `yiji_coupon_id` and on a status that is not approved;
         * the selection above already excludes everything settled. The worst a
         * duplicate costs is one wasted read.
         */
        /* Neither outcome is kept. The sweep carries no custom id, so nothing
           here can block a later attempt — but a queue that hoards every failed
           coupon job grows without bound and tells nobody anything the
           `yiji_push_error` column does not already say. */
        { removeOnComplete: true, removeOnFail: true },
      );
      queued++;
    } catch (err) {
      logger.error(
        {
          id: row.id,
          code: row.coupon_code,
          err: err instanceof Error ? err.message : String(err),
        },
        'could not enqueue an undelivered coupon — the next sweep will try again',
      );
    }
  }
  if (queued > 0) logger.info({ queued }, 'undelivered coupons enqueued');
  return queued;
}

/**
 * Create a coupon on Yiji that belongs to nobody, redeemable by its code.
 *
 * For the customer who has no Yiji account: there is no order to attach the
 * coupon to and no user to grant it to, so both other paths are impossible by
 * definition and the compensation was previously never delivered at all.
 *
 * The agent then sends the customer the code, the app link and how to redeem.
 * Yiji's own `AddCouponToUserByCode` is the other half of that journey, and the
 * customer walks it themselves when they install the app.
 *
 * ONE USE, deliberately. A code travelling over WhatsApp is bearer-like:
 * whoever types it first gets it. `reachLimit`, `limitForUser` and
 * `monthlyReachLimit` already carry the request's own usage limit (1 unless a
 * supervisor said otherwise), so the exposure is one grant of a known amount —
 * not an open cheque.
 */
async function createUnassignedCoupon(args: {
  row: CouponApprovalRow;
  id: string;
  directus: YijiDirectusClient;
  logger: Logger;
  postCoupon: YijiAdminPoster;
  yijiTenantId: string;
  phone: string;
}): Promise<PushOutcome> {
  const { row, id, directus, logger, postCoupon, yijiTenantId, phone } = args;
  const payload = yijiCouponPayload(row, null, { unassigned: true });

  let body: YijiCouponResponse;
  try {
    body = await postCoupon<YijiCouponResponse>(YIJI_UNASSIGNED_COUPON_PATH, payload, {
      ...(yijiTenantId ? { tenantid: yijiTenantId } : {}),
      /* Stable across retries of the same coupon, so a timeout that in fact
         succeeded cannot mint a SECOND coupon carrying the same code. */
      'idempotency-key': `unassigned:${row.coupon_code ?? id}`,
    });
  } catch (err) {
    /* Same two-kinds-of-failure rule as the assigned path: a considered refusal
       is recorded and not retried; an outage throws so BullMQ backs off. */
    if (isYijiRefused(err)) {
      const detail = describeRefusal(err.body);
      await recordFailure(directus, id, `yiji refused the unassigned coupon: ${detail}`);
      logger.warn({ id, code: row.coupon_code, detail }, 'yiji refused the unassigned coupon');
      return 'refused';
    }
    throw new Error(
      `${isYijiUnavailable(err) ? 'yiji unavailable' : 'unassigned coupon create failed'}: ${describeError(err)}`,
    );
  }

  /*
   * A 200 IS NOT A YES, and `AddCoupon` reports differently from every other
   * coupon call: the new id arrives in `exceptionMessage` as "couponId 73900"
   * while `extendedProperties` is EMPTY. Reading it with `readCouponUserId`
   * — which looks in `extendedProperties.CouponUserId` — would call a real
   * creation a refusal. Confirmed twice against the live API.
   */
  const newCouponId = readNewCouponId(body);
  if (newCouponId == null) {
    const detail = describeRefusal(body);
    await recordFailure(directus, id, `yiji refused the unassigned coupon: ${detail}`);
    logger.warn({ id, code: row.coupon_code, err: detail }, 'unassigned coupon refused');
    return 'refused';
  }

  /*
   * `assigned`, not `delivered`: the coupon exists and is spendable, but nobody
   * holds it until the customer redeems the code. `yiji_coupon_user_id` carries
   * Yiji's receipt so the two systems can still be matched from either side.
   */
  await directus.request(
    updateItem('coupon_approvals' as never, id, {
      status: 'assigned',
      /* The COUPON id, not a coupon-user id: nobody holds it yet. It is still
         the receipt that lets the two systems be matched from either side. */
      yiji_coupon_user_id: String(newCouponId),
      yiji_pushed_at: new Date().toISOString(),
      yiji_push_error: null,
    } as never),
  );
  logger.info(
    { id, code: row.coupon_code, phone, couponId: newCouponId },
    'customer has no Yiji account — coupon created UNASSIGNED; send them the code to redeem',
  );
  return 'unassigned';
}

/**
 * The withheld coupon's Yiji id, read on its own.
 *
 * Separate from the main row read on purpose: `yiji_coupon_id` needs a manual
 * `apply:fields`, and a missing field 403s the WHOLE Directus read. Kept apart,
 * a forgotten bootstrap stops only the withheld creations, never a customer's
 * assigned coupon (owner, 2026-10-06).
 */
async function readYijiCouponId(directus: YijiDirectusClient, id: string): Promise<string | null> {
  const r = (await directus.request(
    readItem('coupon_approvals' as never, id, { fields: ['yiji_coupon_id'] } as never),
  )) as unknown as { yiji_coupon_id?: string | number | null } | null;
  const v = r?.yiji_coupon_id;
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}

/**
 * Create a WITHHELD coupon on Yiji: Private, `assignee: []`, held by nobody.
 *
 * THE CASE (owner, 2026-10-06): the agent or supervisor ticked "do not send
 * this to the customer on the Yiji app" — typically a customer who wanted a
 * refund, not an app coupon. The compensation must still be RECORDED on Yiji,
 * so their portal accounts for every coupon the CRM issued, yet nobody may be
 * able to spend it. Until now such a row was skipped entirely and Yiji never
 * heard of it.
 *
 * ONCE. The id Yiji returns lands in `yiji_coupon_id` (never in
 * `yiji_coupon_user_id`, which means "a customer holds it"), and the push
 * checks that column before anything else. A "Coupon with Code … already
 * exists" answer is a settled refusal: recorded in `yiji_push_error`, never
 * retried — asking again cannot change it.
 *
 * The status stays `approved`. `assigned` means a customer holds the coupon,
 * and the entire point here is that none does.
 */
async function createWithheldCoupon(args: {
  row: CouponApprovalRow;
  id: string;
  directus: YijiDirectusClient;
  logger: Logger;
  postCoupon?: YijiAdminPoster;
  readOrder?: YijiOrderReader;
  yijiTenantId: string;
  redirectCouponsTo?: string;
}): Promise<PushOutcome> {
  const { row, id, directus, logger, postCoupon, readOrder, yijiTenantId, redirectCouponsTo } =
    args;

  if (!postCoupon) {
    logger.info(
      { id, code: row.coupon_code },
      'no Yiji service credential configured — withheld coupon not created, staying approved',
    );
    return 'disabled';
  }
  /* Same vendor rule as the assigned path: an unknown platform is skipped,
     never guessed. */
  if (!couponEndpointFor(yijiTenantId)) {
    logger.warn(
      { id, code: row.coupon_code, vendorId: yijiTenantId },
      'no coupon endpoint for this vendor — withheld coupon not created',
    );
    return 'disabled';
  }

  /*
   * STAGING NEVER CREATES A WITHHELD COUPON ON YIJI (2026-10-06).
   *
   * Staging talks to Yiji's PRODUCTION coupon API. Its safety net is the
   * test-handset redirect, which changes WHO a coupon is for — and a withheld
   * coupon is for nobody, so the redirect protected nothing: on the first
   * staging deploy the sweep created 3 old staging test coupons on real Yiji
   * (#74014-74016; private, unassigned, already expired — harmless, kept, never
   * deleted per the owner). Recorded as settled so the sweep stops asking.
   */
  if (redirectCouponsTo?.trim()) {
    await recordFailure(directus, id, 'staging: withheld coupons are never created on Yiji');
    logger.warn(
      { id, code: row.coupon_code },
      'STAGING: withheld coupon NOT created on Yiji (staging shares the production API)',
    );
    return 'refused';
  }

  /*
   * The order, read for the SAME enrichment the assigned coupon gets — Yiji's
   * own brandId/restaurantId and the phone in their format — so the two bodies
   * stay identical. Best-effort, exactly as there: a failed read costs those
   * fields, not the coupon. Read-only (a GET); nothing about the order changes.
   */
  const orderId = couponOrderId(row);
  let order: CouponOrderContext | null = null;
  if (readOrder && orderId) {
    try {
      order = await readOrder(orderId);
    } catch (err) {
      logger.warn(
        { id, orderId, err: describeError(err) },
        'could not read the order for the withheld coupon — creating it without enrichment',
      );
    }
  }

  /* The staging redirect still applies: nothing is assigned, but the NAME is a
     phone number, and on staging that is the test handset's, as it is for an
     assigned coupon. */
  const payload = yijiCouponPayload(row, order, { redirectCouponsTo, withheld: true });
  if (redirectCouponsTo?.trim()) {
    logger.warn(
      { id, code: row.coupon_code, redirectedTo: redirectCouponsTo },
      'STAGING: withheld coupon named after the test handset, NOT the real customer',
    );
  }

  let body: YijiCouponResponse;
  try {
    body = await postCoupon<YijiCouponResponse>(YIJI_UNASSIGNED_COUPON_PATH, payload, {
      ...(yijiTenantId ? { tenantid: yijiTenantId } : {}),
      /* Stable across retries, so a timeout that in fact succeeded cannot mint
         a second coupon with the same code. */
      'idempotency-key': `withheld:${row.coupon_code ?? id}`,
    });
  } catch (err) {
    /* A considered refusal (HTTP 400 with a body — a duplicate code included)
       is recorded and settled; an outage throws so BullMQ backs off. */
    if (isYijiRefused(err)) {
      const detail = describeRefusal(err.body);
      await recordFailure(directus, id, `yiji would not create the withheld coupon: ${detail}`);
      logger.warn({ id, code: row.coupon_code, detail }, 'yiji refused the withheld coupon');
      return 'refused';
    }
    throw new Error(
      `${isYijiUnavailable(err) ? 'yiji unavailable' : 'withheld coupon create failed'}: ${describeError(err)}`,
    );
  }

  /* A 200 is not a yes: `AddCoupon` puts the verdict in `result` and the id in
     `exceptionMessage` ("couponId 73900"). `result: 2` "Coupon with Code …
     already exists!" lands here too — settled, so recorded, not retried. */
  const couponId = readNewCouponId(body);
  if (couponId == null) {
    const detail = describeRefusal(body);
    await recordFailure(directus, id, `yiji would not create the withheld coupon: ${detail}`);
    logger.warn({ id, code: row.coupon_code, detail }, 'yiji refused the withheld coupon');
    return 'refused';
  }

  await directus.request(
    updateItem('coupon_approvals' as never, id, {
      /* No `status` here on purpose — it stays `approved`; nobody holds it. */
      yiji_coupon_id: String(couponId),
      yiji_pushed_at: new Date().toISOString(),
      yiji_push_error: null,
    } as never),
  );
  logger.info(
    { id, code: row.coupon_code, couponId },
    'withheld coupon created on Yiji — Private, assigned to nobody',
  );
  return 'withheld';
}

export async function processCouponPushJob(
  job: Job<CouponPushJob>,
  deps: CouponPushDeps,
): Promise<PushOutcome> {
  const { directus, logger, postCoupon, readOrder, findCustomer, yijiTenantId, redirectCouponsTo } =
    deps;
  const id = job.data.couponApprovalId;

  const row = (await directus.request(
    readItem('coupon_approvals' as never, id, {
      fields: [
        'id',
        'status',
        'coupon_code',
        'coupon_value',
        'coupon_percent',
        'max_discount',
        'usage_limit',
        'valid_from',
        'valid_to',
        'title',
        'issuing_side',
        'delivery_type',
        'coupon_type',
        'discount_category',
        'brand_id',
        'restaurant_id',
        'item_name',
        'no_other_discounts',
        'reason',
        { contact: ['id', 'name', 'phone', 'external_customer_id'] },
        // The order is the whole point of the endpoint, and the receipt tells
        // us whether a previous attempt already succeeded.
        { ticket: ['order_id'] },
        // The standalone order, for a coupon raised with no ticket at all.
        'order_id',
        /* The number for a coupon with NO contact row — every late-order one.
           It is how an order-less grant finds the customer on Yiji. */
        'customer_phone',
        'yiji_coupon_user_id',
        'yiji_push_error',
        'delivery_excluded',
      ],
    } as never),
  )) as unknown as CouponApprovalRow;

  /*
   * Re-read, so a decision reversed since queueing is honoured — and so a
   * coupon Yiji has ALREADY taken is never sent twice. The receipt is the
   * stronger check of the two: a retry after a timeout that in fact succeeded
   * would otherwise grant the customer a second coupon.
   */
  if (row.status === 'assigned' || row.yiji_coupon_user_id) {
    logger.info(
      { id, couponUserId: row.yiji_coupon_user_id },
      'coupon already assigned — nothing to push',
    );
    return 'already-assigned';
  }
  /*
   * ALREADY CREATED AS A WITHHELD COUPON: never again, and never assigned.
   *
   * Checked for EVERY row, not only withheld ones. A supervisor who unticks
   * "do not send" after the withheld coupon exists would otherwise route the
   * row into the assignment path and try to create the same code a second
   * time — and the owner's rule is that a withheld coupon is never assigned
   * (2026-10-06).
   */
  let withheldCouponId: string | null = null;
  try {
    withheldCouponId = await readYijiCouponId(directus, id);
  } catch (err) {
    /* For a withheld row this read IS the idempotency check, so an outage (or
       the column not yet applied) must retry rather than risk a second
       creation. For any other row it is only a guard, and failing it must not
       stop a coupon the customer is owed. */
    if (row.delivery_excluded) {
      throw new Error(`could not read yiji_coupon_id: ${describeError(err)}`);
    }
    logger.warn({ id, err: describeError(err) }, 'could not read yiji_coupon_id — continuing');
  }
  if (withheldCouponId) {
    logger.info(
      { id, code: row.coupon_code, couponId: withheldCouponId },
      'withheld coupon already created on Yiji — nothing to do, and never assigned',
    );
    return 'already-withheld';
  }
  if (row.status !== 'approved' && row.status !== 'edited') {
    logger.warn({ id, status: row.status }, 'coupon is not approved — refusing to push');
    return 'not-approved';
  }
  /*
   * WITHHELD: CREATED ON YIJI, ASSIGNED TO NOBODY (owner, 2026-10-06).
   *
   * Branches off BEFORE every assignment step — the order/user resolution, the
   * contact write-back, both grant endpoints — so a `delivery_excluded` row can
   * never reach a customer however the job was queued, a Retry click included.
   */
  if (row.delivery_excluded) {
    return await createWithheldCoupon({
      row,
      id,
      directus,
      logger,
      postCoupon,
      readOrder,
      yijiTenantId,
      redirectCouponsTo,
    });
  }

  /*
   * THE ONE THING THIS CALL CANNOT BE MADE WITHOUT.
   *
   * `CreateCouponUserFromOrder` attaches a coupon to an order. Without one
   * there is nothing to attach it to: Yiji would answer 200 with a refusal,
   * and the retry would repeat it until the job gave up — a queue full of
   * failures whose real cause is a blank field on our side.
   *
   * The customer's Yiji id is NOT required alongside it. The order already
   * identifies the customer on Yiji's side, which is what the endpoint's name
   * says and what their captured request confirms by sending no `userId` at
   * all. Requiring one would have blocked 18 of the 19 approvals in this
   * database — the guard would have looked correct and caused an outage.
   *
   * Reported as its own outcome and left `approved`, so the coupon is still
   * visibly owed to the customer and a supervisor can see why it has not gone.
   */
  const orderId = couponOrderId(row);
  /*
   * NO ORDER IS NO LONGER THE END OF THE ROAD.
   *
   * `AddCompensationCoupon` grants a coupon to a USER, and its `orderId` is
   * nullable — so a compensation raised from a WhatsApp complaint, which has no
   * order and no Yiji id, can still reach the customer IF their phone resolves
   * to a Yiji account. That resolution is the only new requirement, and it is a
   * lookup rather than a guess: see `findCustomerIdByPhone`, which discards a
   * substring hit that is not actually this number.
   *
   * Still `no-order` when the phone resolves to nobody. That is an ordinary
   * outcome — a walk-in may have no app account at all — and the coupon stays
   * `approved` so it is visibly owed and can be honoured in the branch.
   */
  let compensationUserId: string | null = null;
  if (!orderId) {
    /*
     * THE REDIRECTED NUMBER ON STAGING, THE REAL ONE IN PRODUCTION.
     *
     * This path identifies the customer by `userId`, and Yiji resolves from the
     * id — so looking the REAL customer up on staging and sending their id
     * beside the test handset's phone would grant a coupon to a real stranger,
     * which is precisely what the redirect exists to prevent and which cannot be
     * revoked from our side. The lookup itself is therefore redirected, not just
     * the phone in the payload. `redirectCouponsTo` is empty in production.
     */
    const phone =
      redirectCouponsTo?.trim() || row.customer_phone?.trim() || row.contact?.phone?.trim() || '';
    if (findCustomer && phone) {
      try {
        compensationUserId = await findCustomer(phone);
      } catch (err) {
        /* A lookup that FAILED is not "they have no account". Throwing lets
           BullMQ retry, because the coupon may well be deliverable and
           recording `no-order` here would park it on a transient outage. */
        throw new Error(`yiji customer lookup failed: ${describeError(err)}`);
      }
    }
    if (!compensationUserId) {
      /*
       * "THIS PERSON HAS NO APP ACCOUNT" IS A SETTLED ANSWER, NOT A FAILURE.
       *
       * This used to return without recording anything, which left
       * `yiji_push_error` null — and the delivery sweep selects exactly the
       * rows that are approved, unexcluded and carry no error. So the coupon
       * was re-examined EVERY SWEEP (60s by default), asking Yiji the same
       * question about the same number for ever: ~1,440 futile lookups a day,
       * permanently, per coupon. One of the owner's own coupons
       * (OPS-433RHNBB, 0536418952) is in exactly that state, and a number that
       * resolves to nobody today will not resolve in sixty seconds.
       *
       * Recorded ONLY when a lookup was genuinely possible and genuinely
       * answered "nobody". The two other ways to arrive here are not settled
       * and must stay retryable:
       *   - no `findCustomer`: the credential is absent, nothing was asked;
       *   - no phone at all: a supervisor may yet add one.
       * A lookup that THREW is handled above — it rethrows, because an outage
       * is the opposite of a settled answer.
       *
       * This is not a dead end: `yiji_push_error` is what the Retry control
       * clears, so if the customer later installs the app a supervisor can
       * release it with one click.
       */
      /*
       * NO ACCOUNT IS NO LONGER A DEAD END — CREATE THE COUPON UNASSIGNED.
       *
       * The owner's process (2026-10-02): put the coupon ON Yiji without giving
       * it to anybody, then have the agent send the customer the code, the app
       * link and how to redeem it. When they install and enter the code, Yiji
       * attaches it to the account they have just created.
       *
       * That is the only route left for this customer: no order to attach to,
       * and no user to grant to. Before this they were simply never
       * compensated through the app.
       *
       * Only when a lookup actually RAN and actually answered "nobody". The two
       * other ways to reach this branch are not settled facts and must stay
       * retryable rather than minting a coupon on a guess:
       *   - no `findCustomer`: the credential is absent, nothing was asked;
       *   - no phone at all: a supervisor may yet add one.
       * A lookup that THREW rethrows above — an outage is the opposite of a
       * settled answer.
       */
      if (findCustomer && phone && postCoupon) {
        return await createUnassignedCoupon({
          row,
          id,
          directus,
          logger,
          postCoupon,
          yijiTenantId,
          phone,
        });
      }
      logger.warn(
        {
          id,
          code: row.coupon_code,
          hasPhone: Boolean(phone),
          lookup: Boolean(findCustomer),
        },
        'coupon has no order and no way to look the customer up — staying approved',
      );
      return 'no-order';
    }
    logger.info(
      { id, code: row.coupon_code, yijiUserId: compensationUserId },
      'no order, but the phone resolves to a Yiji customer — granting by user',
    );
  }
  /*
   * Ask Yiji what it already knows about this order.
   *
   * Best-effort by design. Everything it returns is corroboration the endpoint
   * can derive for itself from `orderId`, so a lookup that fails costs a richer
   * payload and nothing more — refusing to deliver an approved coupon because a
   * read-only enrichment call timed out would be the wrong trade by a distance.
   */
  /* Only when there IS an order. The order-less path has nothing to enrich from
     and must not call an order reader with a blank id. */
  let order: CouponOrderContext | null = null;
  if (readOrder && orderId) {
    try {
      order = await readOrder(orderId);
      if (!order) {
        logger.warn(
          { id, orderId },
          'yiji does not know this order — pushing on the order id alone',
        );
      }
    } catch (err) {
      logger.warn(
        { id, orderId, err: describeError(err) },
        'could not read the order for coupon enrichment — pushing without it',
      );
    }
  }

  /*
   * THE ORDER KNOWS WHO THEY ARE — so learn it.
   *
   * Yiji has no lookup by phone, which is why a walk-in's contact is stored
   * with `external_customer_id: null`. But the ORDER carries their real
   * `userId`, and we have just read it. Writing it back turns an anonymous
   * walk-in into a named customer permanently: their next chat resumes, their
   * order history resolves, and later coupons address them directly instead
   * of leaning on the order every time.
   *
   * Only ever null -> real. Never overwritten, and never with a phone-derived
   * handle — a fabricated value in this column is what gets sent to Yiji as
   * `userId`. Best-effort: this is enrichment, and failing it must not stop a
   * coupon the customer is owed.
   */
  const learnedUserId = order?.userId?.trim();
  if (learnedUserId && row.contact?.id && !row.contact.external_customer_id) {
    try {
      await directus.request(
        updateItem('contacts' as never, row.contact.id, {
          external_customer_id: learnedUserId,
        } as never),
      );
      logger.info(
        { id, contactId: row.contact.id, externalCustomerId: learnedUserId, orderId },
        'learned the customer Yiji id from their order — contact promoted',
      );
    } catch (err) {
      logger.warn(
        { id, contactId: row.contact.id, err: describeError(err) },
        'could not write back the customer Yiji id — coupon push continues',
      );
    }
  }

  const payload = yijiCouponPayload(row, order, {
    redirectCouponsTo,
    /* Only set on the order-less path, where the customer cannot be derived
       from an order and must be named outright. */
    ...(compensationUserId ? { compensationUserId } : {}),
  });
  if (redirectCouponsTo) {
    logger.warn(
      { id, code: row.coupon_code, redirectedTo: redirectCouponsTo },
      'STAGING: coupon redirected to the test handset, NOT the real customer',
    );
  }

  if (!postCoupon) {
    logger.info(
      { id, code: row.coupon_code, payload },
      'no Yiji service credential configured — coupon push is disabled, staying approved',
    );
    return 'disabled';
  }

  /*
   * Which platform is this coupon for? One answer today (Yiji), looked up
   * rather than assumed so a second platform is a row in COUPON_ENDPOINTS.
   * An unknown vendor is skipped, not guessed — see `couponEndpointFor`.
   */
  const endpoint = couponEndpointFor(yijiTenantId);
  if (!endpoint) {
    logger.warn(
      { id, code: row.coupon_code, vendorId: yijiTenantId },
      'no coupon endpoint for this vendor — staying approved rather than sending it to the wrong platform',
    );
    return 'disabled';
  }

  let body: YijiCouponResponse;
  try {
    const headers = {
      // Yiji's API is multi-tenant and routes on this.
      ...(yijiTenantId ? { tenantid: yijiTenantId } : {}),
      // Stable across retries of the same job, so a timeout that in fact
      // succeeded cannot become a second coupon.
      'idempotency-key': row.coupon_code ?? id,
    };

    if (compensationUserId) {
      /*
       * THE ORDER-LESS GRANT IS TWO CALLS, NOT ONE.
       *
       * `AddUserCoupon` ATTACHES AN EXISTING COUPON: its `couponId` is the
       * subject, and the nested `coupon` object is ignored. Sending it a
       * coupon to create answers, misleadingly,
       *
       *     { "result": 2, "exceptionMessage": "User already have this coupon" }
       *
       * — which is not about the user at all. Proved by sending two
       * brand-new, never-seen codes for a user id that does not exist: a
       * nonexistent user cannot already hold anything, and both came back with
       * that same sentence. The message means "I could not attach coupon 0".
       *
       * So: CREATE first (`AddCoupon` → `couponId`), then ATTACH that id. Both
       * calls are inside this try, so a failure at either step is handled by
       * the one set of rules below — a considered refusal is recorded, an
       * outage is rethrown and retried.
       */
      /*
       * CREATED AS THE ASSIGNED COUPON WILL BE: Private, reachLimit 10000, every
       * term identical — the `withheld` shape, since it has no assignee for the
       * instant between the two calls (owner, 2026-10-06).
       *
       * This used `unassigned: true`, the shape for a customer with NO account
       * who redeems by code: General, with the TOTAL pool equal to the uses
       * (usually 1). Attached to a customer, that is exactly the reachLimit-1
       * fault that made 88 coupons unredeemable — this path would have made
       * the next one too.
       */
      const created = await postCoupon<YijiCouponResponse>(
        YIJI_UNASSIGNED_COUPON_PATH,
        yijiCouponPayload(row, order, { redirectCouponsTo, withheld: true }),
        headers,
      );
      const couponId = readNewCouponId(created);
      if (couponId == null) {
        /* Yiji declined to create it. Recorded, not retried: the same body
           will be declined the same way next sweep. */
        const detail = describeRefusal(created);
        await recordFailure(directus, id, `yiji would not create the coupon: ${detail}`);
        logger.warn({ id, code: row.coupon_code, detail }, 'yiji refused to create the coupon');
        return 'refused';
      }
      logger.info(
        { id, code: row.coupon_code, couponId },
        'coupon created on yiji — attaching it to the customer',
      );
      body = await postCoupon<YijiCouponResponse>(
        YIJI_COMPENSATION_COUPON_PATH,
        {
          id: 0,
          couponId,
          userId: compensationUserId,
          couponCode: row.coupon_code ?? '',
          couponName: customerFacingCouponName(
            redirectCouponsTo?.trim() ||
              order?.customerPhone ||
              row.customer_phone ||
              row.contact?.phone,
            row.title,
          ),
          compensationReason: crmCouponDescription(row.reason),
          status: 0,
          totalCount: 0,
        },
        headers,
      );
    } else {
      body = await postCoupon<YijiCouponResponse>(endpoint.path, payload, headers);
    }
  } catch (err) {
    /*
     * TWO KINDS OF FAILURE, AND THEY NEED OPPOSITE HANDLING.
     *
     * Yiji returns a considered refusal as HTTP 400 with a JSON body — verified
     * live: `{"result":2,"exceptionMessage":"User already have this coupon"}`.
     * Retrying that gets the same answer five more times and buries the one
     * message that explains why nothing arrived. So it is RECORDED and the job
     * finishes.
     *
     * A 502, a timeout or a dropped connection is the opposite case: nothing
     * has been decided, and trying again is exactly right. Those still throw.
     */
    if (isYijiRefused(err)) {
      const detail = describeRefusal(err.body);
      await recordFailure(directus, id, detail);
      logger.warn(
        { id, code: row.coupon_code, orderId, detail },
        'yiji refused the coupon — staying approved, not retrying',
      );
      return 'refused';
    }
    /*
     * DELIBERATELY WRITES NOTHING.
     *
     * `yiji_push_error` is what parks a coupon — the delivery sweep skips any
     * row carrying one, because a settled refusal repeats forever. Recording a
     * TIMEOUT there would park a coupon that is genuinely owed behind an
     * outage that has since cleared, and only a human noticing would free it.
     * Left blank, the same sweep retries it in five minutes and it heals
     * itself.
     */
    const reason = describeError(err);
    // Rethrown, so BullMQ retries with backoff rather than swallowing it. The
    // status stays `approved`: nothing was delivered, and saying otherwise
    // would be the one lie this whole file is arranged to prevent.
    throw new Error(
      `${isYijiUnavailable(err) ? 'yiji unavailable' : 'yiji coupon push failed'}: ${reason}`,
    );
  }

  /*
   * A 200 IS NOT A YES.
   *
   * Yiji answers 200 whether it granted the coupon or refused it; the verdict
   * is `result` in the body, and the evidence is
   * `extendedProperties.CouponUserId`. Trusting the status code would mark a
   * refused coupon `assigned` and tell every report the customer can redeem
   * something they cannot.
   *
   * Thrown rather than returned, so a transient refusal gets the same retry as
   * a network failure. A permanent one exhausts its attempts and stays
   * `approved`, which is the honest end state: the decision stands, the
   * delivery did not happen.
   */
  const verdict = readCouponUserId(body);
  if (!verdict.ok) {
    /*
     * A refusal can also arrive as a 200 — their API is not consistent about
     * which it uses, so both roads lead here. Recorded and not retried for the
     * same reason: `result` is an answer, not an outage.
     */
    await recordFailure(directus, id, verdict.error ?? 'yiji refused the coupon');
    logger.warn(
      { id, code: row.coupon_code, orderId, detail: verdict.error },
      'yiji refused the coupon in a 200 body — staying approved, not retrying',
    );
    return 'refused';
  }

  await directus.request(
    updateItem('coupon_approvals' as never, id, {
      status: 'assigned',
      // The receipt, written in the SAME patch as the status: a crash between
      // two writes would otherwise leave "assigned" with nothing to prove it.
      yiji_coupon_user_id: verdict.couponUserId,
      yiji_pushed_at: new Date().toISOString(),
      // Cleared on success: a stale reason beside a delivered coupon reads as
      // an unresolved problem and sends someone looking for one.
      yiji_push_error: null,
    } as never),
  );
  logger.info(
    { id, code: row.coupon_code, orderId, couponUserId: verdict.couponUserId },
    'coupon attached to the order on Yiji and marked assigned',
  );
  return 'delivered';
}
