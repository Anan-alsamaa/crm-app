import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItem, updateItems } from '@directus/sdk';
import {
  couponPrefix,
  generateCouponCode,
  startCouponReplacement,
  waitForCouponReplacement,
  type CouponApprovalStatus,
  type CouponFields,
  type CouponReplacementTerms,
  type CouponReplaceState,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { vendorField } from '../../lib/record-vendor.js';
import { jobProducer } from '../../lib/job-producer.js';
import {
  COUPON_LOG_TAG,
  CouponRequestError,
  createCouponRequestIdempotent,
  newCouponRequestId,
  type SendOptions,
} from './coupon-request-send.js';

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
  /* EMA-80: taken back from its ticket. Read only by the ticket's own coupon
     list (useTicketCoupons), and absent where those fields are not applied. */
  removal_status?: string | null;
  removed_at?: string | null;
  removed_reason?: string | null;
  removal_detail?: string | null;
  removed_by?: { id: string; first_name: string | null; email: string | null } | null;
  /* Owner, 2026-10-27: an APPROVED coupon edited = replaced. Read only by the
     ticket's coupon list, and ABSENT (undefined) where the fields are not
     applied - the Edit action is then not offered. */
  replaces?: { id: string; coupon_code: string | null } | null;
  replaced_by?: { id: string; coupon_code: string | null } | null;
  replace_reason?: string | null;
  vendor?: string | null;
  brand_id?: string | null;
  restaurant_id?: string | null;
  delivery_excluded?: boolean | null;
  delivery_excluded_reason?: string | null;
  /* The compensation rule it came from, and whether the agent changed its
     terms (owner, 2026-10-27). ABSENT where the fields are not applied. */
  policy_rule?: { id: string; name: string | null } | null;
  differs_from_policy?: boolean | null;
}

/** Read first, dropped first: the newest columns (2026-10-27, manual apply). */
export const COUPON_POLICY_FIELDS = [
  'differs_from_policy',
  { policy_rule: ['id', 'name'] },
] as const;

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
    queryFn: async () => {
      const read = async (fields: readonly unknown[]) =>
        (await directus.request(
          readItems(
            'coupon_approvals' as never,
            {
              fields: fields as never,
              sort: ['-date_created'],
              limit: -1,
            } as never,
          ),
        )) as unknown as CouponRequestRow[];
      try {
        return await read([...COUPON_REQUEST_FIELDS, ...COUPON_POLICY_FIELDS]);
      } catch {
        /* The compensation-rule columns are not applied here yet. */
        return read(COUPON_REQUEST_FIELDS);
      }
    },
  });
}

export interface CreateCouponRequestInput extends CouponFields {
  /**
   * The new row's id, made in the browser (owner, 2026-10-25). Pass the SAME
   * id to retry a request that failed, so it can never be created twice;
   * left out, one is made for this call.
   */
  id?: string;
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
  /**
   * THE COMPENSATION RULE the coupon was pre-filled from, and whether the
   * agent changed its terms (owner, 2026-10-27). Sent ONLY when a rule was
   * involved - see `policyFields` - so a plain request never names columns an
   * environment may not have yet.
   */
  policy_rule?: string;
  differs_from_policy?: boolean;
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
 *
 * IDEMPOTENT AND RETRIED (owner, 2026-10-25) - see `coupon-request-send.ts`.
 * Every caller (the Add-ticket form, from a chat or not; the ticket card's
 * "Assign a coupon"; the ticket edit form) goes through here, so all of them
 * get the same protection. A failure rejects with a `CouponRequestError`, is
 * logged to the console under `[coupon-request]`, and - for a coupon about a
 * ticket - is written to that ticket's history, so a supervisor can read why.
 */
export function useRequestCouponApproval(opts: Pick<SendOptions, 'delays' | 'sleep'> = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCouponRequestInput) => sendCouponRequest(input, opts),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['my-coupon-requests'] });
      if (vars.ticket) void qc.invalidateQueries({ queryKey: ['ticket-events', vars.ticket] });
    },
    onError: (_e, vars) => {
      if (vars.ticket) void qc.invalidateQueries({ queryKey: ['ticket-events', vars.ticket] });
    },
  });
}

/** Requests that failed in this tab, so a later success can say "sent on retry". */
const failedRequestIds = new Set<string>();

/**
 * One line in the ticket's history (`ticket_events`, append-only; the agent's
 * `create_tickets` privilege grants the create). Written as a `commented`
 * event because that is what the ticket page already renders with its text,
 * on every release; `payload.coupon_request` marks it as the system's line,
 * and it carries no mentions, so it notifies nobody. Best-effort: history
 * must never be the reason a coupon is reported as failed.
 */
async function recordCouponHistory(
  ticketId: string,
  actorId: string | null,
  text: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await directus.request(
      createItem(
        'ticket_events' as never,
        {
          ticket: ticketId,
          event_type: 'commented',
          ...(actorId ? { actor: actorId } : {}),
          payload: { text, coupon_request: detail },
        } as never,
      ),
    );
  } catch (err) {
    console.error(`${COUPON_LOG_TAG} could not write the ticket history line`, err);
  }
}

/** The mutation's body, exported for tests and for callers outside React. */
export async function sendCouponRequest(
  input: CreateCouponRequestInput,
  opts: Pick<SendOptions, 'delays' | 'sleep'> = {},
): Promise<unknown> {
  const { vendor: explicit, id: givenId, ...rest } = input;
  const id = givenId ?? newCouponRequestId();
  try {
    /* THE VENDOR, so the worker delivers it through that vendor's platform
       (MV-1). Best-effort: a coupon request is never lost to this lookup. */
    const vendor = await vendorField({
      explicit,
      ticket: input.ticket ?? null,
      contact: input.contact,
    }).catch(() => ({}));
    const row = await createCouponRequestIdempotent(
      directus,
      id,
      { ...rest, ...vendor } as Record<string, unknown>,
      {
        ...opts,
        onAttemptFailed: (attempt, c, err) =>
          console.warn(
            `${COUPON_LOG_TAG} attempt ${attempt} failed (${c.kind}${c.status ? ` ${c.status}` : ''})`,
            { requestId: id, ticket: input.ticket ?? null, error: err },
          ),
      },
    );
    if (failedRequestIds.delete(id) && input.ticket) {
      await recordCouponHistory(input.ticket, input.requested_by, 'Coupon request sent on retry.', {
        id,
        outcome: 'sent',
      });
    }
    return row;
  } catch (err) {
    const e =
      err instanceof CouponRequestError
        ? err
        : new CouponRequestError({
            kind: 'unknown',
            status: null,
            detail: (err as Error)?.message ?? String(err),
            attempts: 1,
            requestId: id,
          });
    console.error(`${COUPON_LOG_TAG} NOT sent: ${e.message}`, {
      requestId: id,
      ticket: input.ticket ?? null,
      attempts: e.attempts,
      error: err,
    });
    failedRequestIds.add(id);
    if (input.ticket) {
      await recordCouponHistory(
        input.ticket,
        input.requested_by,
        `Coupon request failed: ${e.message}`,
        { id, outcome: 'failed', kind: e.kind, status: e.status, attempts: e.attempts },
      );
    }
    throw e;
  }
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
export function useTicketCoupons(
  ticketId: string | null | undefined,
  opts: { pollWhileRemoving?: boolean } = {},
) {
  return useQuery({
    queryKey: ['ticket-coupons', ticketId],
    enabled: !!ticketId,
    staleTime: 30_000,
    /* While a removal is being worked (EMA-80), look again every few seconds
       so the result - removed, used, or failed - appears without a reload. */
    refetchInterval: opts.pollWhileRemoving ? 3_000 : false,
    queryFn: async (): Promise<CouponRequestRow[]> => {
      const read = (fields: readonly unknown[]) =>
        directus.request(
          readItems(
            'coupon_approvals' as never,
            {
              filter: { ticket: { _eq: ticketId } },
              fields: fields as never,
              sort: ['-date_created'],
              limit: -1,
            } as never,
          ),
        ) as unknown as Promise<CouponRequestRow[]>;
      try {
        return await read([...TICKET_COUPON_REPLACE_FIELDS, ...COUPON_POLICY_FIELDS]);
      } catch {
        /* The compensation-rule columns (2026-10-27) are not applied here. */
      }
      try {
        return await read(TICKET_COUPON_REPLACE_FIELDS);
      } catch {
        /* The edit-after-approval fields (owner, 2026-10-27) need a manual
           apply:fields too: read without them, and the Edit action is simply
           not offered. */
      }
      try {
        return await read(TICKET_COUPON_FIELDS);
      } catch {
        /* The removal fields need a manual apply:fields. Until then Directus
           refuses the WHOLE read - so fall back to the fields every
           environment has, rather than the panel going silently empty. */
        return read(COUPON_REQUEST_FIELDS);
      }
    },
  });
}

/** The ticket's coupon list also reads how (and whether) each was removed. */
export const TICKET_COUPON_FIELDS = [
  ...COUPON_REQUEST_FIELDS,
  'removal_status',
  'removed_at',
  'removed_reason',
  'removal_detail',
  { removed_by: ['id', 'first_name', 'email'] },
] as const;

/**
 * Plus what editing an APPROVED coupon needs (owner, 2026-10-27): both sides of
 * a replacement, and the fields the replacement copies from the original.
 */
export const TICKET_COUPON_REPLACE_FIELDS = [
  ...TICKET_COUPON_FIELDS,
  'vendor',
  'brand_id',
  'restaurant_id',
  'delivery_excluded',
  'delivery_excluded_reason',
  'replace_reason',
  { replaces: ['id', 'coupon_code'] },
  { replaced_by: ['id', 'coupon_code'] },
] as const;

/**
 * EDIT AN APPROVED COUPON from its ticket (owner, 2026-10-27).
 *
 * The replacement is created with THIS user's token; the gateway checks
 * `edit_approved_coupons`; the workers check the old coupon was not used, take
 * it out of the customer's Yiji app and only then send the new one. Waits
 * (bounded) on the two rows for the outcome - no Yiji call from the browser.
 */
export function useReplaceTicketCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      old: CouponRequestRow;
      terms: CouponReplacementTerms;
      reason: string;
      editorId: string | null;
    }): Promise<{ code: string; state: CouponReplaceState; note: string | null }> => {
      const { replacementId, code } = await startCouponReplacement(
        {
          /* Both homes of a code, like the request form's duplicate check. */
          codeTaken: async (c) => {
            const [a, b] = await Promise.all([
              directus.request(
                readItems(
                  'coupon_approvals' as never,
                  { filter: { coupon_code: { _eq: c } }, fields: ['id'], limit: 1 } as never,
                ),
              ) as Promise<unknown[]>,
              directus.request(
                readItems(
                  'tickets' as never,
                  { filter: { coupon_code: { _eq: c } }, fields: ['id'], limit: 1 } as never,
                ),
              ) as Promise<unknown[]>,
            ]);
            return a.length > 0 || b.length > 0;
          },
          create: (row) => directus.request(createItem('coupon_approvals' as never, row as never)),
          enqueue: (body) => jobProducer.replaceCoupon(body),
          abandon: (id, note) =>
            directus.request(
              updateItem('coupon_approvals' as never, id, {
                status: 'rejected',
                decision_note: note,
              } as never),
            ),
          newId: () => newCouponRequestId(),
          newCode: (side) => generateCouponCode(Math.random, couponPrefix(side)),
        },
        input,
      );
      void qc.invalidateQueries({ queryKey: ['ticket-coupons'] });
      const settled = await waitForCouponReplacement(async () => {
        const rows = (await directus.request(
          readItems(
            'coupon_approvals' as never,
            {
              filter: { id: { _in: [input.old.id, replacementId] } },
              fields: ['id', 'status', 'decision_note', 'removal_status', 'replaced_by'],
              limit: 2,
            } as never,
          ),
        )) as unknown as Array<{
          id: string;
          status: string | null;
          decision_note: string | null;
          removal_status: string | null;
          replaced_by: string | null;
        }>;
        return {
          replacement: rows.find((r) => String(r.id) === replacementId) ?? null,
          old: rows.find((r) => String(r.id) === input.old.id) ?? null,
        };
      });
      return { code, ...settled };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['ticket-coupons'] });
      void qc.invalidateQueries({ queryKey: ['my-coupon-requests'] });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: ['ticket'] });
    },
  });
}

/**
 * TAKE A TICKET'S COUPONS BACK (owner, 2026-10-21, EMA-80).
 *
 * Asks the gateway once per coupon; the workers do the removal - in the CRM,
 * and from the customer's Yiji app when it got there - and then set the
 * ticket's Compensation to match. Resolves when every request was ACCEPTED,
 * not when the coupons are gone: the ticket's coupon list shows the outcome.
 */
export function useRemoveTicketCoupons() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      couponIds,
      reason,
    }: {
      ticketId: string;
      couponIds: string[];
      reason: string;
    }) => {
      for (const id of couponIds) await jobProducer.removeCoupon(id, reason);
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['ticket-coupons', vars.ticketId] });
      void qc.invalidateQueries({ queryKey: ['my-coupon-requests'] });
    },
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
