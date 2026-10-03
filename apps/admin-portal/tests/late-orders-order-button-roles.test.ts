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
   * By PREFIX, not an exact list. `WeCare Agent`, `WeCare Supervisor` and
   * `WeCare Admin` all qualify, and a WeCare role added later does not silently
   * lose the button the way a hardcoded array would — which is exactly how this
   * broke.
   */
  it('admits every WeCare role', () => {
    expect(PAGE).toMatch(/\/\^WeCare\\b\/i\.test\(user\?\.role\?\.name \?\? ''\)/);
  });

  it('still admits the owner', () => {
    expect(PAGE).toMatch(/const canSeeOrder = isOwner \|\|/);
  });

  /*
   * EXPORT MUST NOT HAVE BEEN WIDENED. Taking the whole register off the
   * system is a different act from reading one order, and widening it as a side
   * effect of this fix is the kind of change nobody reviews.
   */
  it('leaves the export gate narrow', () => {
    expect(PAGE).toMatch(/const EXPORT_ROLES = \['WeCare Admin', 'WeCare Supervisor'\]/);
    expect(PAGE).toMatch(/const canExport = isOwner \|\| EXPORT_ROLES\.includes/);
  });
});
