import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * TWO REPORT COLUMNS THE OWNER CORRECTED (2026-09-21).
 *
 * Asserted against the source rather than by rendering: both pages need a
 * QueryClient, an auth context and a live Directus to reach their tables, and
 * mocking all three to read one label would test the mocks. These fail the
 * moment somebody puts the old wording or the raw id back.
 */
const read = (rels: string[]) =>
  readFileSync(rels.map((r) => resolve(process.cwd(), r)).find((f) => existsSync(f))!, 'utf8');

const COMPENSATION = read([
  'src/features/coupon-approvals/AllCompensationPage.tsx',
  'apps/admin-portal/src/features/coupon-approvals/AllCompensationPage.tsx',
]);
const BREAKDOWN = read([
  'src/features/report-exports/AgentReportsPage.tsx',
  'apps/admin-portal/src/features/report-exports/AgentReportsPage.tsx',
]);

describe('compensation report', () => {
  it('calls the amount "Coupon value", not "Worth"', () => {
    expect(COMPENSATION).toContain("defaultValue: 'Coupon value'");
    expect(COMPENSATION).not.toContain("defaultValue: 'Worth'");
  });

  /*
   * `restaurant_id` is Yiji's numeric id for the branch. Nobody reading a
   * compensation report knows which restaurant "41" is, so the column shows
   * the branch code and name — falling back to the id only when the row has
   * no ticket to read a store from.
   */
  it('shows the store by name rather than by id', () => {
    expect(COMPENSATION).toContain('r.ticket?.store');
    expect(COMPENSATION).toContain('st.name');
  });

  it('fetches the store so the name is there to show', () => {
    expect(COMPENSATION).toContain("{ store: ['code', 'name', { brand: ['name'] }] }");
  });
});

describe('ticket breakdown', () => {
  /*
   * The coupon code is an internal identifier; the value beside it is what a
   * reader is asking about. Hidden at the PAGE, not removed from
   * `COMPLAINT_COLUMN_KEYS` — that list is also the CSV import's vocabulary,
   * and deleting the key would stop the historical import recognising a
   * column it has always accepted.
   */
  it('drops the coupon code column', () => {
    expect(BREAKDOWN).toContain("k !== 'couponCode'");
  });

  it('hides it from the column picker too, not just the default selection', () => {
    // Every place the page counts or lists columns uses the filtered set.
    expect(BREAKDOWN).not.toContain('COMPLAINT_COLUMN_KEYS.length');
    expect(BREAKDOWN).toContain('REPORT_COLUMN_KEYS.length');
  });
});
