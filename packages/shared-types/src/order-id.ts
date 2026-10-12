/**
 * AN ORDER NUMBER, OR NO ORDER (2026-10-12).
 *
 * The 5 Oct ticket import wrote "0" for "no order" on 25 tickets; every time
 * one was opened the inbox asked Yiji for order 0, which Yiji answers with a
 * 500 - ~48 wasted calls a day. Blank and all-zero values are no order at all.
 */
export function normalizeOrderId(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^0+$/.test(s)) return null;
  return s;
}

/** A ticket payload with its `order_id`, when present, normalized. */
export function withNormalizedOrderId<T extends object>(payload: T): T {
  if (!('order_id' in payload)) return payload;
  return { ...payload, order_id: normalizeOrderId((payload as { order_id?: unknown }).order_id) };
}
