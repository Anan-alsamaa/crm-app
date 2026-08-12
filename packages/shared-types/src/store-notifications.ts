/**
 * Telling the branch about a complaint raised against it.
 *
 * Not every ticket is the store's business. A technical issue with the app or a
 * driver's attitude is nothing the branch manager can act on, and a queue that
 * forwards everything is a queue nobody reads — so the branch is told only when
 * the COMPLAINT TYPE says the branch is where it happened. Which types those are
 * is an operations decision, kept as data (`store_notify_rules`) rather than a
 * constant here, because it will change without a deploy.
 *
 * What the branch receives is deliberately narrow: the description and the
 * resolution notes, and nothing else. Not the customer's name or phone, not the
 * coupon, not the agent. A branch needs to know what went wrong and what was
 * promised on their behalf; the rest is the customer's business with us.
 *
 * This module is pure. It decides and shapes; it does not send. Delivery waits
 * on the POS integration — see `store_notifications`, which is the outbox those
 * decisions are recorded in.
 */

/** The ticket's side of the decision, as the form knows it at save time. */
export interface StoreNotificationInput {
  ticketId: string;
  /** Live link to the branch. Without one there is nobody to tell. */
  storeId: string | null;
  complaintType: string | null;
  description: string | null;
  /** The agent's `response_desc` — what was done about it. */
  resolutionNotes: string | null;
}

/** A row destined for `store_notifications`, ready to insert. */
export interface StoreNotificationDraft {
  ticket: string;
  store: string;
  complaint_type: string;
  description: string | null;
  resolution_notes: string | null;
  status: 'queued';
}

/** Why a ticket did not produce a notification. Reported, never guessed at. */
export type StoreNotificationSkip = 'no-store' | 'no-complaint-type' | 'type-not-notifying';

/**
 * Does this complaint type notify the branch?
 *
 * Compared case-insensitively on a trimmed value because the enabled list is
 * typed by an admin and the ticket's value comes from a locked dropdown; a
 * trailing space in the configuration must not silently switch the feature off
 * for a whole category.
 */
export function isNotifyingType(
  complaintType: string | null | undefined,
  enabledTypes: readonly string[],
): boolean {
  const t = complaintType?.trim().toLowerCase();
  if (!t) return false;
  return enabledTypes.some((e) => e.trim().toLowerCase() === t);
}

/**
 * The notification a ticket should produce, or the reason it produces none.
 *
 * A skip is a named reason rather than a bare null: "this type does not notify"
 * and "this ticket has no branch attached" are different facts, and only one of
 * them is a configuration choice.
 */
export function storeNotificationDraft(
  input: StoreNotificationInput,
  enabledTypes: readonly string[],
): { draft: StoreNotificationDraft } | { skip: StoreNotificationSkip } {
  const complaintType = input.complaintType?.trim() ?? '';
  if (!complaintType) return { skip: 'no-complaint-type' };
  if (!isNotifyingType(complaintType, enabledTypes)) return { skip: 'type-not-notifying' };
  // Ordered after the type check on purpose: a ticket whose type does not
  // notify is not "missing a branch", and reporting it that way would send
  // someone looking for a branch to attach that would change nothing.
  if (!input.storeId) return { skip: 'no-store' };

  const text = (s: string | null | undefined) => {
    const v = s?.trim();
    return v ? v : null;
  };
  return {
    draft: {
      ticket: input.ticketId,
      store: input.storeId,
      complaint_type: complaintType,
      // Only these two, by request. Empty stays null rather than becoming an
      // empty string, so "nothing was written" cannot be read as "they wrote
      // nothing of substance".
      description: text(input.description),
      resolution_notes: text(input.resolutionNotes),
      status: 'queued',
    },
  };
}
