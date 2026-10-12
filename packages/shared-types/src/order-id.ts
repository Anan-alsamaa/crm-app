/**
 * AN ORDER NUMBER, OR NO ORDER - FOR DISPLAY ONLY (owner, 2026-10-12).
 *
 * Tickets keep exactly what was saved: the 5 Oct import stored "0" on 25
 * tickets that have no order, and they stay as they are. On screen, blank and
 * all-zero mean "no order" and read "-" (they used to read "#0" or blank), and
 * nothing asks Yiji for order 0.
 */
export function normalizeOrderId(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^0+$/.test(s)) return null;
  return s;
}

/** What a table cell shows for an order number: the number, or "-". */
export function orderLabel(value: unknown): string {
  return normalizeOrderId(value) ?? '-';
}
