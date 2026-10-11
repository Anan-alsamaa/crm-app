import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * LIVE ORDERS (owner, 2026-10-11): the button is pinned outside the sideways
 * scroll and is green ON / red OFF; live shows today's Pending + Commented late
 * orders, a handled one (coupon given) drops off; every new order beeps; the
 * creation time and business day are the ORDER's own.
 */
const page = readFileSync(
  resolve(__dirname, '../src/features/late-orders/LateOrdersPage.tsx'),
  'utf8',
);

describe('Late orders: live mode', () => {
  it('pins the header (and its Live button) above the scrolling table', () => {
    const header = page.indexOf("title={t('lateOrders.title'");
    const scrollport = page.indexOf('flex-1 overflow-auto px-4');
    expect(header).toBeGreaterThan(0);
    expect(header).toBeLessThan(scrollport);
  });

  it('is green when on and red when off, with fixed colours', () => {
    expect(page).toMatch(/backgroundColor: liveMode \? '#16a34a' : '#dc2626'/);
  });

  it('hides an order once it is handled, keeps Pending and Commented', () => {
    expect(page).toMatch(/if \(liveMode && stateOf\(r\.orderId\) === 'handled'\) return false;/);
  });

  it('beeps when a new late order arrives while live', () => {
    expect(page).toMatch(/if \(arrived > 0 && liveMode\) playMessageBeep\(\);/);
  });

  it("shows the order's own placed time and business day", () => {
    expect(page).toMatch(/formatDateTime\(placedIso\(row\.placedAt\)\)/);
    expect(page).toMatch(/businessDay\(row\.placedAt\)/);
  });

  it('refreshes the decisions as often as the queue while live', () => {
    expect(page).toMatch(
      /useLateOrderDecisions\(\s*activeRange \?\? undefined,\s*vendorFilter \|\| undefined,\s*liveMode,?\s*\)/,
    );
  });
});
