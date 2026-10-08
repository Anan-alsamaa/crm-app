import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItems } from '@directus/sdk';
import type { CouponApprovalStatus, CouponFields } from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { vendorField } from '../../lib/record-vendor.js';

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
  /** Yiji's item id for that line — the key, where the name is the label. */
  item_sku: string | null;
  /** Yes = cannot be used on an already-discounted item. */
  no_other_discounts: boolean | null;
  /** True when an admin changed the agent's values before approving. */
  edited_by_admin: boolean | null;
  decided_at: string | null;
  decision_note: string | null;
  date_created: string | null;
  ticket: { id: string; subject: string | null; order_id: string | null } | null;
  /** The order, for a coupon raised WITHOUT a ticket — every late-order one. */
  order_id: string | null;
  /** The number when no contact row carries it — every late-order one. */
  customer_phone: string | null;
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
  'item_sku',
  'no_other_discounts',
  'edited_by_admin',
  // Both read so a late-order coupon — which has neither ticket nor contact —
  // can still show its order and the customer's number.
  'order_id',
  'customer_phone',
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
  /**
   * The ticket this compensates, when there is one.
   *
   * OPTIONAL since 2026-09-21. A coupon given straight from the late-orders
   * queue has an order and no complaint behind it; `order_id` below carries
   * the only thing delivery actually needs. A coupon raised from a ticket
   * still sets this, and the ticket's order still wins — see `couponOrderId`.
   */
  ticket?: string | null;
  /** The Yiji order, for a coupon raised without a ticket. */
  order_id?: string | null;
  contact: string | null;
  /**
   * The customer's number when NO contact row stands behind the request.
   *
   * A late-order coupon has neither a ticket nor a contact — a late order is
   * deliberately not a reason to put somebody in the customer directory — so
   * the compensation report had no number to show for any of them.
   *
   * DISPLAY ONLY. The push worker reads the real number from Yiji's own order
   * record (`order.customerPhone`), so delivery never depends on this.
   */
  customer_phone?: string | null;
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
  item_sku?: string | null;
  no_other_discounts?: boolean;
  /**
   * Whether this coupon should ever be pushed to the Yiji app.
   *
   * True for a customer who wants a refund and will not accept an app coupon
   * (owner, 2026-10-01). The request is still created, still approved and still
   * recorded; `coupon-push` checks this BEFORE the approved check, so the row is
   * inert however the job was queued — including a Retry — and counts as "not
   * owed" rather than failed.
   */
  delivery_excluded?: boolean;
  /** Why it is withheld, shown on the supervisor's approval card. Optional. */
  delivery_excluded_reason?: string | null;
  /* Resolved from the ticket's order, never chosen in the form. */
  brand_id?: string | null;
  restaurant_id?: string | null;
  /**
   * The vendor this coupon is for (MV-1) — the platform it is delivered to.
   * Usually left out: the mutation takes it from the ticket, else the
   * customer, else the single active vendor. See `resolveRecordVendor`.
   */
  vendor?: string | null;
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
    mutationFn: async (input: CreateCouponRequestInput) => {
      /* THE VENDOR, so the worker delivers it through that vendor's platform
         (MV-1). Best-effort: a coupon request is never lost to this lookup. */
      const { vendor: explicit, ...rest } = input;
      const vendor = await vendorField({
        explicit,
        ticket: input.ticket ?? null,
        contact: input.contact,
      });
      return directus.request(
        createItem('coupon_approvals' as never, { ...rest, ...vendor } as never),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-coupon-requests'] });
    },
  });
}

/**
 * CORRECT A REQUEST THAT IS STILL PENDING (owner, 2026-09-28).
 *
 * An agent who mistyped a value had no way to fix it — the request went to a
 * supervisor exactly as entered, and the only remedies were to have it rejected
 * or to let a wrong coupon through.
 *
 * ONLY WHILE PENDING, and the filter enforces it SERVER-SIDE rather than
 * trusting the button to be hidden: `status: pending` is part of the update's
 * own filter, so a request decided between the dialog opening and Save being
 * pressed matches nothing and changes nothing. Hiding a control is not a lock —
 * the decision is what the supervisor approved, and it must not move under them.
 *
 * The CUSTOMER and the ORDER are deliberately not updatable here: those are
 * what the request IS ABOUT, and changing them would make it a different
 * request wearing the same id (owner's choice, 2026-09-28).
 */
/**
 * What a correction may change.
 *
 * Named explicitly rather than `Partial<CouponRequestRow>`: the customer, the
 * order, the status and the decision are all things a correction must NOT be
 * able to touch, and a wide type would make omitting them a matter of
 * remembering rather than of the compiler.
 */
export interface PendingCouponPatch {
  title?: string | null;
  coupon_code?: string | null;
  issuing_side?: string | null;
  delivery_type?: string | null;
  coupon_type?: string | null;
  discount_category?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  coupon_value?: number | null;
  coupon_percent?: number | null;
  max_discount?: number | null;
  usage_limit?: number | null;
  reason?: string | null;
  item_name?: string | null;
  item_sku?: string | null;
  no_other_discounts?: boolean | null;
  /* A correction may change its mind about delivering — the customer can ask
     for a refund after the request was raised, which is the whole reason this
     choice exists. */
  delivery_excluded?: boolean | null;
  delivery_excluded_reason?: string | null;
}

export function useUpdatePendingCouponRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PendingCouponPatch }) => {
      const updated = (await directus.request(
        updateItems(
          'coupon_approvals' as never,
          { id: { _eq: id }, status: { _eq: 'pending' } } as never,
          patch as never,
        ),
      )) as unknown as unknown[];
      /* An empty result means the filter matched nothing — the row was decided
         while the form was open. Saying so is the whole point: a silent no-op
         would read as a saved edit. */
      if (!Array.isArray(updated) || updated.length === 0) {
        throw new Error('This request has already been decided, so it can no longer be changed.');
      }
      return updated;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-coupon-requests'] });
      void qc.invalidateQueries({ queryKey: ['all-compensation'] });
    },
  });
}

/**
 * The coupons raised against ONE ticket.
 *
 * The ticket already carries a code, a value and a percent as plain columns —
 * enough to say a coupon exists, not enough to answer the questions an agent
 * is actually asked on the phone: has it been approved, what does it cover,
 * until when, and did a supervisor change the amount. Those live on the
 * request, so the ticket reads them from here rather than growing a dozen more
 * columns that would then have to be kept in step.
 */
export function useTicketCoupons(ticketId: string | null | undefined) {
  return useQuery({
    queryKey: ['ticket-coupons', ticketId],
    enabled: !!ticketId,
    staleTime: 30_000,
    queryFn: async (): Promise<CouponRequestRow[]> =>
      (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            filter: { ticket: { _eq: ticketId } },
            fields: COUPON_REQUEST_FIELDS as never,
            sort: ['-date_created'],
            limit: -1,
          } as never,
        ),
      )) as unknown as CouponRequestRow[],
  });
}

/**
 * Is this coupon code already taken?
 *
 * The code was generated and read-only until agents asked to type their own —
 * they reuse a code a branch already printed, or match one from the ops sheet.
 * Letting them type it means letting them collide with one, and a duplicate
 * code is not a cosmetic problem: the coupon push sends it to Yiji as the
 * `idempotency-key`, so a second request carrying an existing code would be
 * treated as a retry of the FIRST and silently deliver nothing.
 *
 * Both places a code can live are checked. `coupon_approvals` holds every
 * request ever made; `tickets.coupon_code` is where an APPROVED one lands, and
 * a coupon approved before this collection existed lives only there.
 *
 * `ignoreId` is the request being edited, so a row never collides with itself.
 */
export function useCouponCodeTaken(code: string | null | undefined, ignoreId?: string) {
  const trimmed = (code ?? '').trim().toUpperCase();
  return useQuery({
    queryKey: ['coupon-code-taken', trimmed, ignoreId ?? ''],
    // Nothing to ask about an empty box, and a code is not a code until it has
    // some length — querying on every keystroke from the first character is a
    // request per letter for an answer that is always "free".
    enabled: trimmed.length >= 4,
    staleTime: 10_000,
    queryFn: async (): Promise<boolean> => {
      const [approvals, tickets] = await Promise.all([
        directus.request(
          readItems(
            'coupon_approvals' as never,
            {
              filter: { coupon_code: { _eq: trimmed } },
              fields: ['id'],
              limit: 2,
            } as never,
          ),
        ) as Promise<Array<{ id: string }>>,
        directus.request(
          readItems(
            'tickets' as never,
            {
              filter: { coupon_code: { _eq: trimmed } },
              fields: ['id'],
              limit: 1,
            } as never,
          ),
        ) as Promise<Array<{ id: string }>>,
      ]);
      const others = approvals.filter((r) => r.id !== ignoreId);
      return others.length > 0 || tickets.length > 0;
    },
  });
}
