import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE TICKET BREAKDOWN FOLLOWS EACH ROLE'S OWN PERMISSIONS (owner, 2026-11-12).
 *
 * The page is offered to `view_all_tickets`. A new General Area Manager got
 * "connection issue" because the report also read coupons, which his role may
 * not - one refused read failed the whole page. The owner's rule: "apply the
 * ticket role, dont give the coupon role". So:
 *  - `view_all_tickets` grants NO coupon read (no quiet widening);
 *  - the report's coupon read is best-effort and a refusal is told apart
 *    from "no coupons" (null);
 *  - without it, every coupon column (Compensation, Coupon value, Coupon %),
 *    the Compensation filter and the Compensated card are hidden, and the
 *    rest of the report shows.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SYNC = read('../../../directus/extensions/app-roles-sync/index.js');
const REPORT = read('../../../apps/admin-portal/src/features/report-exports/api.ts');
const PAGE = read('../../../apps/admin-portal/src/features/report-exports/AgentReportsPage.tsx');

describe('ticket breakdown: the ticket permission never brings coupon data', () => {
  const block = SYNC.slice(
    SYNC.indexOf('    view_all_tickets: ['),
    SYNC.indexOf('    create_tickets: ['),
  );

  it('view_all_tickets grants no coupon read', () => {
    expect(block.length).toBeGreaterThan(20);
    expect(block).not.toMatch(/g\('coupon_approvals'/);
  });

  it('the coupon read is best-effort, and a refusal is null (not "no coupons")', () => {
    const at = REPORT.indexOf('fields: [...BREAKDOWN_COUPON_FIELDS]');
    expect(at).toBeGreaterThan(0);
    expect(REPORT.slice(Math.max(0, at - 600), at)).toMatch(/attempt\(/);
    expect(REPORT.slice(at, at + 800)).toMatch(/return null;/);
    expect(REPORT).toMatch(/const compensationAvailable = coupons !== null;/);
  });

  it('without coupon access every coupon column, the filter and the card are hidden', () => {
    expect(PAGE).toMatch(
      /COUPON_DATA_COLUMNS: readonly ComplaintColumnKey\[\] = \[\s*'compensation',\s*'couponValue',\s*'couponPercent',\s*\]/,
    );
    expect(PAGE).toMatch(/compensationAvailable \|\| !COUPON_DATA_COLUMNS\.includes\(k\)/);
    expect(PAGE).toMatch(/compensationAvailable=\{data\.compensationAvailable !== false\}/);
    expect(PAGE).toMatch(/\{compensationAvailable && \(\s*<FilterSelect/);
    expect(PAGE).toMatch(/\{compensationAvailable && \(\s*<ReportKpi/);
  });
});
