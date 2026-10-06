import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * EVERY WeCare ROLE MAY OPEN THE ORDER BEHIND A LATE DELIVERY.
 *
 * Reported by operations (2026-10-03): a WeCare AGENT found the Orders button
 * in the admin late-orders report "blocked".
 *
 * It was not blocked — it was never rendered. The cell was gated on
 * `canExport`, whose role list names only `WeCare Admin` and `WeCare
 * Supervisor`, so an agent saw nothing at all and had no way to know why.
 *
 * Agents are the people working these orders. Refusing them the order behind a
 * late delivery is refusing them the job. EXPORTING is a different act — it
 * takes the whole register, delivery addresses included, off the system — so it
 * keeps its narrower list rather than being widened by association. The two
 * were only ever the same gate because they read the same column.
 *
 * Asserted against the SOURCE: the page needs an auth context, a QueryClient
 * and a live Directus transport to mount, and mocking all three to observe one
 * boolean would be testing the mocks.
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');
const PAGE = read('src/features/late-orders/LateOrdersReportPage.tsx');

describe('who may open the order panel', () => {
  /* THE REGRESSION ITSELF: `canSeeOrder = canExport` hid it from agents. */
  it('is no longer just the export gate', () => {
    expect(PAGE).not.toMatch(/const canSeeOrder = canExport;/);
  });

  /*
   * Its own privilege since 2026-10-06 (`view_order_details`). Its default
   * still admits every WeCare role by PREFIX, and `can()` always admits the
   * owner; both live with the defaults in shared-types.
   */
  it('is gated on view_order_details', () => {
    expect(PAGE).toMatch(/const canSeeOrder = can\('view_order_details'\)/);
  });

  /*
   * EXPORT MUST NOT HAVE BEEN WIDENED. Taking the whole register off the
   * system is a different act from reading one order, and widening it as a side
   * effect of this fix is the kind of change nobody reviews.
   */
  it('keeps export on its own privilege', () => {
    expect(PAGE).toMatch(/const canExport = can\('export_late_orders'\)/);
  });
});
