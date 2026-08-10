/**
 * Orders an agent looked up BY HAND, remembered per conversation.
 *
 * Automatic order lookup joins `contacts.external_customer_id` to the commerce
 * customer. That join is missing for a phone or walk-in enquiry, so the agent
 * types the order number the customer reads out. Without somewhere to keep it,
 * that result vanished the moment they clicked away — and they had to type it
 * again to raise the ticket.
 *
 * So a looked-up order is PINNED to its conversation and stays visible until a
 * ticket is created from it. The ticket takes a snapshot of the order, at which
 * point the pin has done its job and is cleared: leaving it would show the same
 * order twice, once live in the sidebar and once frozen on the ticket, with no
 * way to tell which is authoritative.
 *
 * sessionStorage, not localStorage: this is scratch state for the shift in
 * progress, not something to resurrect on a machine days later. It also survives
 * a refresh, which localStorage-free component state would not.
 */
import type { YijiOrder } from '@yiji/shared-types';

const KEY = 'yiji.pinnedOrders.v1';

type Pinned = Record<string, YijiOrder>;

/** Subscribers, so every mounted view reacts to a pin without prop-drilling. */
const listeners = new Set<() => void>();

function read(): Pinned {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Pinned) : {};
  } catch {
    // Private mode, quota, or corrupt JSON — behave as if nothing is pinned
    // rather than taking the sidebar down with us.
    return {};
  }
}

function write(next: Pinned): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best effort: the pin is a convenience, never the source of truth */
  }
  for (const fn of listeners) fn();
}

export function getPinnedOrder(conversationId: string | null | undefined): YijiOrder | null {
  if (!conversationId) return null;
  return read()[conversationId] ?? null;
}

export function pinOrder(conversationId: string, order: YijiOrder): void {
  write({ ...read(), [conversationId]: order });
}

/** Called once a ticket has captured the order — see the note above. */
export function clearPinnedOrder(conversationId: string | null | undefined): void {
  if (!conversationId) return;
  const next = read();
  if (!(conversationId in next)) return;
  delete next[conversationId];
  write(next);
}

export function subscribePinnedOrders(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
