import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, updateItem } from '@directus/sdk';
import {
  approvedCouponPatch,
  couponOrderId,
  COUPON_APPROVED_STATUSES,
  type CouponApprovalStatus,
} from '@yiji/shared-types';
import { jobProducer } from '../../lib/job-producer.js';
import { directus } from '../../lib/directus.js';
import { commerce } from '../../lib/commerce-client.js';

/**
 * The supervisor's side of coupon approval.
 *
 * Approving is TWO writes and the order matters: the coupon goes onto the
 * ticket first, then the request is marked approved. Backwards, a failure
 * between them leaves a request that says "approved" with no coupon anywhere —
 * an agent tells the customer it is done and nothing was issued. This way the
 * same failure leaves a coupon on the ticket and a request still showing
 * pending, which is visible and re-decidable rather than silently wrong.
 */
export interface CouponApprovalRow {
  id: string;
  coupon_code: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  compensation: string | null;
  reason: string | null;
  status: CouponApprovalStatus;
  /* The coupon's own terms, as the agent asked for them. */
  title: string | null;
  issuing_side: string | null;
  delivery_type: string | null;
  coupon_type: string | null;
  discount_category: string | null;
  valid_from: string | null;
  valid_to: string | null;
  max_discount: number | null;
  usage_limit: number | null;
  /** The specific order item the coupon compensates, when it is about one. */
  item_name: string | null;
  /** Yiji's item id for that line — groupable where the name is not. */
  item_sku: string | null;
  /** Yes = cannot be used on an already-discounted item. */
  no_other_discounts: boolean | null;
  /**
   * The customer's number when the coupon was raised without a CONTACT.
   *
   * A late-order coupon has no contact row — the queue knows a phone, not a CRM
   * customer — so this is the only place the customer appears. It is also what
   * the coupon's TITLE is built from, which is why the two must agree.
   */
  customer_phone: string | null;
  brand_id: string | null;
  restaurant_id: string | null;
  /** True when a supervisor changed those terms before approving. */
  edited_by_admin: boolean | null;
  /**
   * DELIVERY, which is not the same thing as the decision.
   *
   * `yiji_coupon_user_id` is the receipt — present only once Yiji actually
   * holds the coupon. `yiji_push_error` is why it does not, in Yiji's own
   * words. Without both on screen an approved coupon that was refused looks
   * exactly like one the worker has not reached yet, and the customer is told
   * about compensation that does not exist.
   */
  yiji_coupon_user_id: string | null;
  yiji_pushed_at: string | null;
  yiji_push_error: string | null;
  /** Marked never-send — a test row, or honoured in the branch instead. */
  delivery_excluded: boolean | null;
  delivery_excluded_reason: string | null;
  decided_at: string | null;
  decision_note: string | null;
  date_created: string | null;
  /**
   * The order, when this coupon was raised without a ticket (the late-orders
   * queue). `couponOrderId` prefers the ticket's when both exist.
   */
  order_id: string | null;
  ticket: {
    id: string;
    subject: string | null;
    complaint_type: string | null;
    description: string | null;
    order_id: string | null;
    priority: string | null;
    status: string | null;
    store: {
      id: string;
      code: string | null;
      name: string | null;
      city: string | null;
      brand: { name: string | null } | null;
    } | null;
  } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  requested_by: { id: string; first_name: string | null; email: string | null } | null;
  decided_by: { id: string; first_name: string | null; email: string | null } | null;
}

export function useCouponApprovals(status: CouponApprovalStatus | 'all' = 'pending') {
  return useQuery({
    queryKey: ['coupon-approvals', status],
    // Short: several supervisors may be working the same queue, and a decision
    // taken next to you should not stay on screen as still-pending.
    refetchInterval: 30_000,
    queryFn: async () =>
      (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            fields: [
              'id',
              'coupon_code',
              'coupon_value',
              'coupon_percent',
              'compensation',
              'reason',
              'status',
              'decided_at',
              'decision_note',
              'date_created',
              'title',
              'issuing_side',
              'delivery_type',
              'coupon_type',
              'discount_category',
              'valid_from',
              'valid_to',
              'max_discount',
              'usage_limit',
              'item_name',
              'item_sku',
              'no_other_discounts',
              'customer_phone',
              'brand_id',
              'restaurant_id',
              'edited_by_admin',
              'yiji_coupon_user_id',
              'yiji_pushed_at',
              'yiji_push_error',
              'delivery_excluded',
              'delivery_excluded_reason',
              'order_id',
              {
                ticket: [
                  'id',
                  'subject',
                  'complaint_type',
                  'description',
                  'order_id',
                  'priority',
                  'status',
                  // The branch this complaint was about. The coupon's own
                  // `restaurant_id` is Yiji's identifier — right for the push,
                  // useless to read — so the readable name comes from here.
                  { store: ['id', 'code', 'name', 'city', { brand: ['name'] }] },
                ],
              },
              { contact: ['id', 'name', 'phone'] },
              { requested_by: ['id', 'first_name', 'email'] },
              { decided_by: ['id', 'first_name', 'email'] },
            ],
            // Newest first: a queue is worked from the top, and the request
            // that just came in is the one somebody is waiting on.
            sort: ['-date_created'],
            limit: -1,
            // "approved" is every APPROVED decision — 'edited' (terms amended)
            // and 'assigned' (delivered) included. Listing only two of the three
            // meant an amended approval matched NO tab and simply vanished.
            ...(status === 'all'
              ? {}
              : status === 'approved'
                ? { filter: { status: { _in: [...COUPON_APPROVED_STATUSES] } } }
                : { filter: { status: { _eq: status } } }),
          } as never,
        ),
      )) as unknown as CouponApprovalRow[],
  });
}

export interface DecideInput {
  row: CouponApprovalRow;
  approve: boolean;
  note: string;
  supervisorId: string | null;
  /**
   * Terms the supervisor changed before approving.
   *
   * A supervisor who thinks 50 SAR is too much has three honest options:
   * reject it, approve it as asked, or approve a smaller one. The third is what
   * actually happens and used to require rejecting and asking the agent to
   * redo it. Approving an amended request is recorded AS an amendment —
   * `edited_by_admin` — so the report can tell it apart from a straight
   * approval and an agent can see their number was changed.
   */
  edits?: Record<string, unknown> &
    Partial<
      Pick<
        CouponApprovalRow,
        | 'title'
        | 'issuing_side'
        | 'delivery_type'
        | 'coupon_type'
        | 'discount_category'
        | 'valid_from'
        | 'valid_to'
        | 'max_discount'
        | 'usage_limit'
        | 'coupon_value'
        | 'coupon_percent'
        | 'item_name'
        | 'reason'
      >
    >;
}

export function useDecideCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ row, approve, note, supervisorId, edits }: DecideInput) => {
      // Amendments are applied to the REQUEST before the coupon is written from
      // it, so the ticket and the audited request can never tell different
      // stories about what was granted.
      const amended = edits && Object.keys(edits).length > 0 ? { ...row, ...edits } : row;
      if (approve) {
        /**
         * APPROVING SOMETHING THAT CANNOT BE DELIVERED IS THE FAILURE TO STOP.
         *
         * The history matters, because this guard has now been wrong twice in
         * the same way — by naming one route to the customer and treating it as
         * the only one.
         *
         * It first demanded a TICKET. Approving without one skipped the write
         * and marked the request approved anyway, so the page said "the coupon
         * is on the ticket" when it was on nothing at all.
         *
         * It was then narrowed to the ORDER, on the premise that the order "is
         * the only thing Yiji needs to deliver a coupon". THAT IS NO LONGER
         * TRUE, and arguably never was: `AddCompensationCoupon` grants by
         * `userId` with a nullable `orderId`, and the worker reaches it by
         * resolving the customer's PHONE (see `coupon-push.ts`). A WhatsApp
         * compensation has no order and delivers perfectly well.
         *
         * The symptom was precise: three real pending coupons — OPS-433RHNBB,
         * OPS-ZGTYPVZQ, OPS-A2KK9EL7 — could not be approved at all, because
         * this threw before anything was written (owner, 2026-10-01). Two of
         * them resolve to real Yiji customers and would have been delivered.
         *
         * So the question is no longer "is there an order?" but "is there ANY
         * way to reach this customer?" — an order, or a phone. Only a request
         * with neither is refused, which is the one case where approving would
         * record a compensation that nothing can carry out.
         *
         * A rejection is still allowed without either: turning something down
         * needs no destination.
         */
        /*
         * A WITHHELD COUPON NEEDS NO ROUTE AT ALL.
         *
         * `delivery_excluded` means "record this, do not send it" — the refund
         * customer who will not accept an app coupon. Nothing is going to Yiji,
         * so demanding a way to reach them is demanding a destination for a
         * journey nobody is making, and it would block the very case the
         * checkbox exists to serve (owner, 2026-10-01).
         *
         * Checked FIRST, before reachability, for the same reason the push
         * worker checks it before everything else: an excluded row must be
         * inert however it got here.
         */
        const withheld = row.delivery_excluded === true;
        const reachable =
          withheld ||
          Boolean(couponOrderId(row)) ||
          Boolean((row.customer_phone ?? row.contact?.phone ?? '').trim());
        if (!reachable) {
          throw new Error('COUPON_APPROVAL_NO_ORDER');
        }
        // The coupon reaches the ticket FIRST — see the note at the top — and
        // carries the AMENDED terms, not what the agent originally asked for.
        // A ticket-less coupon has nothing to stamp; the request itself is the
        // record, and the worker delivers it from `order_id`.
        if (row.ticket?.id) {
          await directus.request(
            updateItem('tickets' as never, row.ticket.id, approvedCouponPatch(amended) as never),
          );
        }
      }
      const decided = await directus.request(
        updateItem('coupon_approvals' as never, row.id, {
          ...(edits ?? {}),
          status: approve ? 'approved' : 'rejected',
          // An approval of changed terms is still an approval, but the report
          // has to be able to count it separately.
          edited_by_admin: approve && !!edits && Object.keys(edits).length > 0,
          decided_at: new Date().toISOString(),
          decided_by: supervisorId,
          // Only overwritten when something was actually typed. A supervisor
          // who saved amended terms wrote their REASON here; approving
          // afterwards without typing anything used to null it, deleting the
          // only account of why the numbers had changed.
          ...(note.trim() ? { decision_note: note.trim() } : {}),
        } as never),
      );

      /**
       * Hand the approval to Yiji — after the decision is safely recorded, and
       * without letting it affect the outcome.
       *
       * Deliberately not awaited into the result and deliberately swallowed. A
       * supervisor's decision is made the moment they make it; if Yiji is down,
       * or Redis is, the right behaviour is a coupon sitting at `approved` for
       * the worker to deliver later — not an error telling the supervisor their
       * approval failed when it did not. The gap between `approved` and
       * `assigned` is exactly the record of what has not reached Yiji yet.
       */
      if (approve) {
        void jobProducer.enqueueCouponPush(row.id).catch(() => {
          /* delivery is the worker's promise, not this click's */
        });
      }
      return decided;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['coupon-approvals'] });
      /*
       * THE DECISION CHANGED A TICKET, SO EVERY TICKET READER IS NOW STALE.
       *
       * Approving writes `compensation`, `coupon_code` and the amounts onto
       * the ticket, and the reports read exactly those columns. Only the queue
       * was invalidated, so a supervisor who approved a coupon and went to
       * Ticket breakdown saw the row WITHOUT its compensation and reasonably
       * concluded the approval had not worked (owner, 2026-09-17).
       *
       * `refetchOnWindowFocus` did not cover it: the report sets
       * `staleTime: 60_000`, and focus does not refetch data still considered
       * fresh — so the gap was up to a minute with nothing on screen saying so.
       */
      void qc.invalidateQueries({ queryKey: ['agent-reports'] });
      void qc.invalidateQueries({ queryKey: ['complaint-metrics'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-metrics'] });
    },
  });
}

/**
 * Save amended terms WITHOUT deciding.
 *
 * Editing used to be inseparable from approving: the only way to keep a change
 * was to press Approve, so a supervisor who wanted to correct a date and come
 * back to the decision had to either approve early or lose the edit. This
 * writes the terms and leaves the request exactly where it was in the queue.
 *
 * Deliberately does NOT set `edited_by_admin`. That flag means "approved on
 * different terms than were asked for", which is a statement about a DECISION;
 * a pending request that has been tidied has not been decided yet, and the
 * coupon report counts amendments as an outcome.
 */
export function useSaveCouponTerms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; edits: Record<string, unknown> }) =>
      directus.request(updateItem('coupon_approvals' as never, input.id, input.edits as never)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coupon-approvals'] }),
  });
}

/**
 * Try the delivery again after Yiji refused it.
 *
 * A refusal is recorded rather than retried — Yiji answers a settled "no" the
 * same way every time, and repeating it only buries the reason. That leaves the
 * coupon parked, which is right until somebody has DONE something about it:
 * corrected the order, or established that the customer really should get a
 * second coupon.
 *
 * So this is deliberately a human action. Clearing `yiji_push_error` is what
 * un-parks the row — the worker's delivery sweep picks up anything approved,
 * undelivered and unrefused — and the direct enqueue means the supervisor sees
 * the result now rather than within five minutes. The enqueue is best-effort
 * for the same reason it is on the approve path: if Redis is down the sweep
 * still gets there.
 */
export function useRetryCouponDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await directus.request(
        updateItem('coupon_approvals' as never, id, { yiji_push_error: null } as never),
      );
      await jobProducer.enqueueCouponPush(id).catch(() => {
        /* the sweep is the safety net */
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coupon-approvals'] }),
  });
}

/**
 * Whether a phone resolves to a Yiji customer — i.e. whether an order-less
 * coupon can actually be delivered.
 *
 * The approval card warns only when the answer is a definite NO, so the shape
 * matters: `configured` false means nothing was asked and the caller must stay
 * silent rather than treat an unanswered question as absence.
 *
 * DISABLED on an empty phone, so a row that needs no lookup makes no call. The
 * answer is cached for the session — a customer does not acquire an account
 * while a supervisor reads one card — and never retried, because a failure here
 * must not turn into a warning about the customer.
 */
export function useCustomerReachable(phone: string) {
  const trimmed = (phone ?? '').trim();
  return useQuery({
    queryKey: ['yiji-customer-exists', trimmed],
    enabled: trimmed.length > 0,
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: () => commerce.customerExists(trimmed),
  });
}
