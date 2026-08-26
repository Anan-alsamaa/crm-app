import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { readItem, readItems, updateItem } from '@directus/sdk';
import type {
  CouponOrderContext,
  CouponPushJob,
  YijiAdminPoster,
  YijiOrderReader,
} from '@yiji/shared-types';
import {
  couponWindow,
  internationalPhone,
  isPhoneDerivedCustomerId,
  isYijiRefused,
  isYijiUnavailable,
  yijiCouponEnum,
  yijiDeliveryTypes,
  yijiIssuingSideId,
  YIJI_ORDER_MAXIMUM,
  YIJI_COUPON_CATEGORY,
  YIJI_COUPON_TYPE,
} from '@yiji/shared-types';
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
   * Yiji's `tenantid` header. Their API is multi-tenant and mis-routes a call
   * without it; the captured request sends `1`.
   */
  yijiTenantId: string;
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
  reason: string | null;
  contact: {
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
   */
  ticket: { order_id: string | null } | null;
  yiji_coupon_user_id: string | null;
  /** Why the last delivery attempt did not land. Null once it does. */
  yiji_push_error?: string | null;
  /** Never send this one — a test row, or honoured another way. */
  delivery_excluded?: boolean | null;
}

/** Postgres returns `numeric` as a string; Yiji is sent numbers. */
function num(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
): Record<string, unknown> {
  const orderId = num(row.ticket?.order_id ?? null);
  const window = row.valid_from && row.valid_to ? couponWindow(row.valid_from, row.valid_to) : null;
  const amount = num(row.coupon_value);
  const percent = num(row.coupon_percent);
  const cap = num(row.max_discount);
  const limit = num(row.usage_limit) ?? 1;
  const deliveryTypes = yijiDeliveryTypes(row.delivery_type);

  /*
   * Their id first, ours only if it is genuinely theirs.
   *
   * `external_customer_id` is null for every walk-in and was, for a while,
   * filled with a `cust-<digits>` handle our own gateway minted — which is why
   * this refuses anything phone-derived rather than trusting the column.
   */
  const stored = row.contact?.external_customer_id?.trim();
  const yijiUserId =
    order?.userId ?? (stored && !isPhoneDerivedCustomerId(stored) ? stored : undefined);

  // Theirs verbatim — it is already in their format — else ours, converted.
  const phone = order?.customerPhone ?? internationalPhone(row.contact?.phone) ?? undefined;

  return {
    id: 0,
    orderId,
    usedAmount: 0,
    status: 0,
    couponUser: {
      id: 0,
      // Yiji creates the coupon; we are not naming one it already holds.
      couponId: 0,
      orderId,
      status: 0,
      // OUR code, so the two systems can be matched from either side later.
      couponCode: row.coupon_code ?? '',
      couponName: row.title ?? '',
      compensationReason: row.reason ?? '',
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
        name: row.title ?? '',
        code: row.coupon_code ?? '',
        compensationReason: row.reason ?? '',
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
        discount: amount ?? 0,
        discountPercentage: percent ?? 0,
        ...(cap != null ? { maximumDiscount: cap } : {}),
        /*
         * HOW MANY TIMES IT MAY BE USED.
         *
         * Yiji has three separate limit fields and the CRM has one box, so all
         * three carry the same number rather than leaving any of them at its
         * default:
         *   reachLimit        total redemptions
         *   limitForUser      per-customer cap
         *   monthlyReachLimit what their console labels "Monthly coupon use"
         *
         * `monthlyReachLimit` was NOT being sent, so it sat at 0 in their UI
         * while the CRM said 1 — the owner reads that field, and a blank there
         * reads as "no limit" on a coupon that is meant to be a single grant.
         *
         * A compensation coupon is one grant unless somebody said otherwise, so
         * the same figure in all three is the honest encoding: use it once, by
         * this customer, this month.
         */
        reachLimit: limit,
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
    },
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
  | 'disabled'
  | 'not-approved'
  | 'already-assigned'
  | 'no-order'
  /**
   * Marked never-send. Not a failure and not a refusal — somebody decided this
   * coupon must not reach Yiji, because it was a test or because the branch
   * already honoured it in person.
   */
  | 'excluded'
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
            // Never-send rows are not "owed" — see `delivery_excluded`.
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
         * refusal, on `delivery_excluded` and on a status that is not approved;
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

export async function processCouponPushJob(
  job: Job<CouponPushJob>,
  deps: CouponPushDeps,
): Promise<PushOutcome> {
  const { directus, logger, postCoupon, readOrder, yijiTenantId } = deps;
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
        'reason',
        { contact: ['name', 'phone', 'external_customer_id'] },
        // The order is the whole point of the endpoint, and the receipt tells
        // us whether a previous attempt already succeeded.
        { ticket: ['order_id'] },
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
   * Checked BEFORE anything else that could send it, and before the
   * not-approved check, because an excluded row must be inert no matter what
   * state it is in or how the job was queued — including a Retry click.
   */
  if (row.delivery_excluded) {
    logger.info({ id, code: row.coupon_code }, 'coupon is marked never-send — not pushing');
    return 'excluded';
  }
  if (row.status !== 'approved' && row.status !== 'edited') {
    logger.warn({ id, status: row.status }, 'coupon is not approved — refusing to push');
    return 'not-approved';
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
  const orderId = row.ticket?.order_id?.trim();
  if (!orderId) {
    logger.warn(
      { id, code: row.coupon_code },
      'coupon has no order to attach to — staying approved',
    );
    return 'no-order';
  }
  /*
   * Ask Yiji what it already knows about this order.
   *
   * Best-effort by design. Everything it returns is corroboration the endpoint
   * can derive for itself from `orderId`, so a lookup that fails costs a richer
   * payload and nothing more — refusing to deliver an approved coupon because a
   * read-only enrichment call timed out would be the wrong trade by a distance.
   */
  let order: CouponOrderContext | null = null;
  if (readOrder) {
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

  const payload = yijiCouponPayload(row, order);

  if (!postCoupon) {
    logger.info(
      { id, code: row.coupon_code, payload },
      'no Yiji service credential configured — coupon push is disabled, staying approved',
    );
    return 'disabled';
  }

  let body: YijiCouponResponse;
  try {
    body = await postCoupon<YijiCouponResponse>(YIJI_COUPON_PATH, payload, {
      // Yiji's API is multi-tenant and routes on this.
      ...(yijiTenantId ? { tenantid: yijiTenantId } : {}),
      // Stable across retries of the same job, so a timeout that in fact
      // succeeded cannot become a second coupon.
      'idempotency-key': row.coupon_code ?? id,
    });
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
