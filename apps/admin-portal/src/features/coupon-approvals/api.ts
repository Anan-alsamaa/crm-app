import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, updateItem } from '@directus/sdk';
import { approvedCouponPatch, type CouponApprovalStatus } from '@yiji/shared-types';
import { jobProducer } from '../../lib/job-producer.js';
import { directus } from '../../lib/directus.js';

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
  brand_id: string | null;
  restaurant_id: string | null;
  /** True when a supervisor changed those terms before approving. */
  edited_by_admin: boolean | null;
  decided_at: string | null;
  decision_note: string | null;
  date_created: string | null;
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
              'brand_id',
              'restaurant_id',
              'edited_by_admin',
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
            // "approved" includes "assigned": delivery to Yiji moves the status
            // on, and an approved coupon must not vanish from the Approved tab
            // the moment the worker gets it there.
            ...(status === 'all'
              ? {}
              : status === 'approved'
                ? { filter: { status: { _in: ['approved', 'assigned'] } } }
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
         * Approving with no ticket used to skip the write and mark the request
         * approved anyway, and the page then said "the coupon is on the
         * ticket". It was not on anything. The supervisor believed they had
         * issued it, the agent told the customer it was done, and nothing
         * existed. Refusing is the only honest outcome: there is nowhere to put
         * the coupon, so the decision cannot be carried out.
         *
         * A rejection is still allowed without a ticket — turning something
         * down needs no destination.
         */
        if (!row.ticket?.id) {
          throw new Error('COUPON_APPROVAL_NO_TICKET');
        }
        // The coupon reaches the ticket FIRST — see the note at the top — and
        // carries the AMENDED terms, not what the agent originally asked for.
        await directus.request(
          updateItem('tickets' as never, row.ticket.id, approvedCouponPatch(amended) as never),
        );
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
