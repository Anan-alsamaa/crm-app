import { couponDecision } from '@yiji/shared-types';

/**
 * The Compensation report's cells that were EMPTY on real rows (owner,
 * 2026-10-15: "some data is empty so please fix to display all").
 *
 * Measured on prod, 30 coupons over 13-15 Oct:
 *
 * - **Item** was blank on 17. `item_name` is filled only when the agent picks
 *   a line on the coupon form; most coupons are about the ORDER (a late order,
 *   a missing drink) and never got one. The order itself is on record twice:
 *   `tickets.order_snapshot` for a ticket coupon, and
 *   `late_order_decisions.order_snapshot` for a ticketless late-order coupon.
 *   Both carry the lines. One row even had `item_sku` with no name.
 * - **Note** was blank on 29 of 30 — it is the supervisor's `decision_note`,
 *   written only when they type one. Nothing else holds it, so an approval
 *   without one now SAYS so rather than rendering as a gap.
 * - **Approved by** / **Date** were blank on exactly one row: the one still
 *   PENDING. Undecided, not missing — the cell now says so.
 *
 * Pure, so the page and its CSV export cannot disagree and the rules are
 * testable without a QueryClient.
 */

/** The bits of an order snapshot this needs — same shape on both collections. */
export interface SnapshotItems {
  items?: Array<{ sku?: string | null; name?: string | null } | null> | null;
}

export interface ItemSource {
  item_name: string | null;
  item_sku?: string | null;
  order_id?: string | null;
  ticket?: { order_id?: string | null; order_snapshot?: SnapshotItems | null } | null;
}

/** Distinct, trimmed names in order — a line ordered twice is one item. */
function distinct(names: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const n of names) {
    const v = n?.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * What the coupon was for, best source first:
 *
 * 1. the item the agent picked (`item_name`);
 * 2. that item's NAME looked up by `item_sku` in the order (the sku was saved,
 *    the name was not);
 * 3. the order's items — the ticket's snapshot, then the late-order decision's.
 *
 * Empty only when the coupon has no item AND no order snapshot anywhere.
 */
export function compensatedItem(r: ItemSource, lateSnapshot?: SnapshotItems | null): string {
  const own = r.item_name?.trim();
  if (own) return own;
  const lines = [...(r.ticket?.order_snapshot?.items ?? []), ...(lateSnapshot?.items ?? [])];
  const skus = (r.item_sku ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (skus.length) {
    const named = distinct(
      skus.map((sku) => lines.find((l) => l?.sku?.trim() === sku && l?.name?.trim())?.name),
    );
    if (named.length) return named.join(', ');
  }
  const snap = r.ticket?.order_snapshot?.items?.length
    ? r.ticket.order_snapshot.items
    : (lateSnapshot?.items ?? []);
  return distinct(snap.map((l) => l?.name)).join(', ');
}

/** The order a ticketless coupon is about — the key into the late decisions. */
export function lateOrderKey(r: ItemSource): string | null {
  if (r.item_name?.trim() || r.ticket?.order_snapshot?.items?.length) return null;
  const id = (r.order_id ?? r.ticket?.order_id ?? '').trim();
  return id || null;
}

export interface DecisionSource {
  status: string | null;
  decision_note: string | null;
  delivery_excluded_reason?: string | null;
}

/** True while nobody has decided — then decider and date CANNOT exist yet. */
export const isUndecided = (r: { status: string | null }) => couponDecision(r.status) === 'pending';

/**
 * The supervisor's note; the withhold reason when they wrote that instead;
 * otherwise an honest label — "pending" before a decision, "no note" after one.
 */
export function noteCell(r: DecisionSource, labels: { pending: string; noNote: string }): string {
  const note = r.decision_note?.trim() || r.delivery_excluded_reason?.trim();
  if (note) return note;
  return isUndecided(r) ? labels.pending : labels.noNote;
}
