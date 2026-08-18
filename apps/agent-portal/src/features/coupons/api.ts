import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems } from '@directus/sdk';
import type { CouponApprovalStatus, CouponFields } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';

/**
 * Every compensation/coupon request, from every agent.
 *
 * Read-only from the agent's side. Reads are queue-wide (roles.ts): the
 * compensation queue is a shared pool and any agent answering a customer needs
 * to see what a colleague already asked for. There is deliberately no update
 * hook here: an agent who could PATCH `status` would be approving their own
 * coupon, which is the one thing the collection exists to prevent — so the
 * absence is a control, not an oversight.
 */
export interface CouponRequestRow {
  id: string;
  coupon_code: string | null;
  coupon_value: number | null;
  coupon_percent: number | null;
  compensation: string | null;
  reason: string | null;
  status: CouponApprovalStatus;
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
  /** True when an admin changed the agent's values before approving. */
  edited_by_admin: boolean | null;
  decided_at: string | null;
  decision_note: string | null;
  date_created: string | null;
  ticket: { id: string; subject: string | null; order_id: string | null } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  requested_by: { id: string; first_name: string | null; email: string | null } | null;
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
  'edited_by_admin',
  { ticket: ['id', 'subject', 'order_id'] },
  { contact: ['id', 'name', 'phone'] },
  { requested_by: ['id', 'first_name', 'email'] },
  { decided_by: ['id', 'first_name', 'email'] },
] as const;

/** The whole queue — every agent's requests, newest first. */
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
  /* The coupon's own terms, validated by CouponRequestDraft before we get here. */
  title?: string;
  issuing_side?: string;
  delivery_type?: string;
  coupon_type?: string;
  discount_category?: string;
  valid_from?: string;
  valid_to?: string;
  max_discount?: number;
  usage_limit?: number;
  /** The specific order item the coupon compensates, when it is about one. */
  item_name?: string | null;
  /* Resolved from the ticket's order, never chosen in the form. */
  brand_id?: string | null;
  restaurant_id?: string | null;
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
