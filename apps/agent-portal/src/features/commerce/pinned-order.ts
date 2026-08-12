/**
 * The orders an agent has put in front of themselves for a conversation, and
 * which one a new ticket should be about.
 *
 * TWO SEPARATE THINGS, deliberately:
 *
 *   ADDED orders — ones the agent looked up by number and kept. Automatic
 *   lookup joins `contacts.external_customer_id` to the commerce customer, and
 *   that join is missing for a phone or walk-in enquiry; it also only returns
 *   the newest couple of orders, so a complaint about an older one needs the
 *   agent to fetch it. Kept per conversation so the result survives navigating
 *   away, and removable because the agent chose to add it and may be wrong.
 *
 *   The CHOSEN order — the one the agent clicked to raise a complaint about.
 *   This is what the ticket snapshots. It is not the same as "added": a
 *   conversation can show three orders while the complaint is about one, and
 *   guessing (say, the newest) would silently file the ticket against the
 *   wrong order with nothing on screen to say so.
 *
 * sessionStorage, not localStorage: scratch state for the shift in progress,
 * not something to resurrect on a machine days later. It survives a refresh,
 * which component state would not.
 */
import type { YijiOrder } from '@yiji/shared-types';

const ADDED_KEY = 'yiji.addedOrders.v1';
const CHOSEN_KEY = 'yiji.chosenOrder.v1';

type AddedMap = Record<string, YijiOrder[]>;
type ChosenMap = Record<string, YijiOrder>;

/** Subscribers, so every mounted view reacts without prop-drilling. */
const listeners = new Set<() => void>();

/**
 * Parsed snapshots, cached against the raw string.
 *
 * `useSyncExternalStore` compares snapshots by identity, and JSON.parse hands
 * back a new object every call — so an uncached read re-renders forever
 * ("Maximum update depth exceeded"). Caching until the stored text actually
 * changes gives a stable reference, which is the contract the hook needs.
 */
const cache = new Map<string, { raw: string | null; parsed: unknown }>();

function read<T>(key: string): T {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
  } catch {
    // Private mode or quota — behave as if nothing is stored rather than
    // taking the sidebar down with us.
    return {} as T;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.parsed as T;
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {}; // corrupt JSON reads as empty
  }
  cache.set(key, { raw, parsed });
  return parsed as T;
}

function write(key: string, next: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* best effort: this is a convenience, never the source of truth */
  }
  for (const fn of listeners) fn();
}

/* ── Orders the agent added by hand ────────────────────────────────────── */

/** Stable empty array: a new [] each call would loop useSyncExternalStore. */
const NONE: readonly YijiOrder[] = Object.freeze([]);

export function getAddedOrders(conversationId: string | null | undefined): readonly YijiOrder[] {
  if (!conversationId) return NONE;
  return read<AddedMap>(ADDED_KEY)[conversationId] ?? NONE;
}

/** Add a looked-up order. Adding the same order twice is a no-op, not a copy. */
export function addOrder(conversationId: string, order: YijiOrder): void {
  const all = read<AddedMap>(ADDED_KEY);
  const list = all[conversationId] ?? [];
  if (list.some((o) => o.orderId === order.orderId)) return;
  write(ADDED_KEY, { ...all, [conversationId]: [...list, order] });
}

export function removeOrder(conversationId: string, orderId: string): void {
  const all = read<AddedMap>(ADDED_KEY);
  const list = all[conversationId];
  if (!list) return;
  const next = list.filter((o) => o.orderId !== orderId);
  if (next.length === list.length) return;
  const map = { ...all };
  if (next.length) map[conversationId] = next;
  else delete map[conversationId];
  write(ADDED_KEY, map);
  // Removing an order the ticket was going to be about would leave the choice
  // pointing at something no longer on screen.
  if (getChosenOrder(conversationId)?.orderId === orderId) clearChosenOrder(conversationId);
}

/* ── The order a new ticket will be about ──────────────────────────────── */

export function getChosenOrder(conversationId: string | null | undefined): YijiOrder | null {
  if (!conversationId) return null;
  return read<ChosenMap>(CHOSEN_KEY)[conversationId] ?? null;
}

/** The agent clicked THIS order to raise a complaint about it. */
export function chooseOrder(conversationId: string, order: YijiOrder): void {
  write(CHOSEN_KEY, { ...read<ChosenMap>(CHOSEN_KEY), [conversationId]: order });
}

/** Called once a ticket has captured the order — the choice has been spent. */
export function clearChosenOrder(conversationId: string | null | undefined): void {
  if (!conversationId) return;
  const all = read<ChosenMap>(CHOSEN_KEY);
  if (!(conversationId in all)) return;
  const next = { ...all };
  delete next[conversationId];
  write(CHOSEN_KEY, next);
}

export function subscribeOrderPins(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── Compatibility aliases ─────────────────────────────────────────────── */

/**
 * The previous names for "the order a new ticket is about".
 *
 * Kept so this change does not have to edit CreateTicketDialog, which another
 * session is rewriting right now — renaming three call sites there would
 * collide with 127 lines of in-flight work for no behavioural gain. The
 * meaning is identical: what used to be "the pinned order" was only ever read
 * as "the order the ticket should snapshot".
 *
 * Safe to delete once that work lands and the call sites can be renamed.
 */
export const getPinnedOrder = getChosenOrder;
export const clearPinnedOrder = clearChosenOrder;
