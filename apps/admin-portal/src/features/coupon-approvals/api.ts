import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readItems, updateItem } from '@directus/sdk';
import { approvedCouponPatch, type CouponApprovalStatus } from '@yiji/shared-types';
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
  decided_at: string | null;
  decision_note: string | null;
  date_created: string | null;
  ticket: { id: string; subject: string | null; complaint_type: string | null } | null;
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
              { ticket: ['id', 'subject', 'complaint_type'] },
              { contact: ['id', 'name', 'phone'] },
              { requested_by: ['id', 'first_name', 'email'] },
              { decided_by: ['id', 'first_name', 'email'] },
            ],
            sort: ['date_created'],
            limit: -1,
            ...(status === 'all' ? {} : { filter: { status: { _eq: status } } }),
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
}

export function useDecideCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ row, approve, note, supervisorId }: DecideInput) => {
      if (approve && row.ticket?.id) {
        // The coupon reaches the ticket FIRST — see the note at the top.
        await directus.request(
          updateItem('tickets' as never, row.ticket.id, approvedCouponPatch(row) as never),
        );
      }
      return directus.request(
        updateItem('coupon_approvals' as never, row.id, {
          status: approve ? 'approved' : 'rejected',
          decided_at: new Date().toISOString(),
          decided_by: supervisorId,
          decision_note: note.trim() || null,
        } as never),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['coupon-approvals'] });
    },
  });
}
