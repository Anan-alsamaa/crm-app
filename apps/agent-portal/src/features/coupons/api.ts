import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems } from '@directus/sdk';
import type { CouponApprovalStatus, CouponFields } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * Coupons this agent has asked for.
 *
 * Read-only from the agent's side, and scoped by Directus itself to their own
 * requests (`requested_by = $CURRENT_USER` in roles.ts). There is deliberately
 * no update hook here: an agent who could PATCH `status` would be approving
 * their own coupon, which is the one thing the collection exists to prevent —
 * so the absence is a control, not an oversight.
 */
export interface CouponRequestRow {
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
  ticket: { id: string; subject: string | null } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  decided_by: { id: string; first_name: string | null; email: string | null } | null;
}

export const COUPON_REQUEST_FIELDS = [
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
  { ticket: ['id', 'subject'] },
  { contact: ['id', 'name', 'phone'] },
  { decided_by: ['id', 'first_name', 'email'] },
] as const;

export function useMyCouponRequests() {
  return useQuery({
    queryKey: ['my-coupon-requests'],
    queryFn: async () =>
      (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            fields: COUPON_REQUEST_FIELDS,
            sort: ['-date_created'],
            limit: -1,
          } as never,
        ),
      )) as unknown as CouponRequestRow[],
  });
}

export interface CreateCouponRequestInput extends CouponFields {
  ticket: string;
  contact: string | null;
  requested_by: string | null;
  reason?: string | null;
}

/**
 * Ask a supervisor for a coupon.
 *
 * `status` is left to the schema default rather than sent: a client that names
 * its own starting status is one typo away from creating an already-approved
 * request.
 */
export function useRequestCouponApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCouponRequestInput) =>
      directus.request(createItem('coupon_approvals' as never, input as never)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-coupon-requests'] });
    },
  });
}
