import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE TICKET BREAKDOWN MUST OPEN FOR EVERYONE WHO SEES IT IN THE MENU (owner,
 * 2026-11-12). The page is offered to `view_all_tickets`. It also read coupons
 * - which Area Manager roles were never granted - so a new General Area
 * Manager got "connection issue" and a long wait instead of the report.
 *
 * This keeps the two files in step: every coupon field the report reads must
 * be granted by `view_all_tickets` in app-roles-sync, and the read itself must
 * stay best-effort (a refusal never empties the page). Add a field to the
 * report without granting it and this fails in CI, not in front of a manager.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SYNC = read('../../../directus/extensions/app-roles-sync/index.js');
const REPORT = read('../../../apps/admin-portal/src/features/report-exports/api.ts');

const listAfter = (src: string, marker: string): string[] => {
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  const open = src.indexOf('[', at + marker.length - 1);
  const close = src.indexOf(']', open);
  return [...src.slice(open + 1, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
};

describe('ticket breakdown reads only what view_all_tickets grants', () => {
  const block = SYNC.slice(
    SYNC.indexOf('    view_all_tickets: ['),
    SYNC.indexOf('    create_tickets: ['),
  );

  it('view_all_tickets grants a field-limited coupon read', () => {
    expect(block).toMatch(/g\('coupon_approvals', 'read', \{\}, \[/);
  });

  it('every coupon field the report reads is granted', () => {
    const granted = listAfter(block, "g('coupon_approvals', 'read', {}, [");
    const used = listAfter(REPORT, 'export const BREAKDOWN_COUPON_FIELDS = [');
    expect(used.length).toBeGreaterThan(0);
    for (const f of used) expect(granted).toContain(f);
  });

  it('no money, code or phone is granted with it', () => {
    const granted = listAfter(block, "g('coupon_approvals', 'read', {}, [");
    for (const f of ['coupon_value', 'coupon_code', 'customer_phone', 'max_discount']) {
      expect(granted).not.toContain(f);
    }
  });

  it('the coupon read is best-effort: a refusal never fails the whole report', () => {
    const at = REPORT.indexOf('fields: [...BREAKDOWN_COUPON_FIELDS]');
    expect(at).toBeGreaterThan(0);
    const before = REPORT.slice(Math.max(0, at - 600), at);
    expect(before).toMatch(/attempt\(/);
  });

  it('refused, the Compensation column is HIDDEN and the rest shows (owner, 2026-11-12)', () => {
    const after = REPORT.slice(REPORT.indexOf('fields: [...BREAKDOWN_COUPON_FIELDS]'));
    // The refusal is told apart from "no coupons": null, not an empty list.
    expect(after.slice(0, 800)).toMatch(/return null;/);
    expect(REPORT).toMatch(/const compensationAvailable = coupons !== null;/);
    expect(REPORT).toMatch(/compensationAvailable,\n/);
    const PAGE = read(
      '../../../apps/admin-portal/src/features/report-exports/AgentReportsPage.tsx',
    );
    expect(PAGE).toMatch(/compensationAvailable \|\| k !== 'compensation'/);
    expect(PAGE).toMatch(/compensationAvailable=\{data\.compensationAvailable !== false\}/);
    expect(PAGE).toMatch(/\{compensationAvailable && \(\s*<FilterSelect/);
  });
});
