import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE ADMIN PORTAL SHOWS THE SAME NAME THE AGENT PORTAL DOES.
 *
 * Owner, 2026-10-05, after the `+966`→`05` fix shipped in `v1.37.0`:
 *
 *   "i see the customer name by default is +966508315325 which is still with
 *    the +966, and not 0508315325 starting with 05."
 *
 * He was right. `v1.37.0` fixed the AGENT portal and every one of its read
 * sites — and the ADMIN portal was never touched. It held **eight** raw
 * `contact?.name` reads and did not import `displayContactName` at all, so the
 * same customer read `+966508315325` in one portal and `0508315325` in the
 * other, which is the exact fault the helper exists to prevent.
 *
 * The lesson: "fixed at the query, not the render sites" was the right
 * principle and I applied it to one app. A shared helper is only as good as
 * the number of callers that reach for it, so these assertions name every
 * surface rather than trusting the next person to remember.
 *
 * Measured on production: 220 of 297 contacts have a phone-shaped name, 101 of
 * them in the `+966…` form the owner saw.
 */
const read = (p: string) => readFileSync(resolve(import.meta.dirname, '..', p), 'utf8');

/** Every admin surface that renders a customer's name. */
const SURFACES: ReadonlyArray<{ file: string; what: string }> = [
  { file: 'src/features/report-exports/api.ts', what: 'ticket + conversation reports' },
  { file: 'src/features/ticket-ops/api.ts', what: 'ticket operations' },
  { file: 'src/features/performance/AgentPerformancePage.tsx', what: 'agent performance' },
  { file: 'src/features/coupon-approvals/AllCompensationPage.tsx', what: 'all compensation' },
  { file: 'src/features/coupon-approvals/CouponApprovalsPage.tsx', what: 'coupon approvals' },
];

describe('every admin surface resolves the name through the shared helper', () => {
  it.each(SURFACES)('$what calls displayContactName', ({ file }) => {
    expect(read(file)).toContain('displayContactName(');
  });

  it.each(SURFACES)('$what imports it from shared-types', ({ file }) => {
    expect(read(file)).toMatch(
      /import[\s\S]{0,200}displayContactName[\s\S]{0,200}@yiji\/shared-types/,
    );
  });
});

describe('no raw name read survives on a display path', () => {
  /*
   * The exact shapes that were there. A raw `?? ''` or `?? '—'` on a name is
   * the bug: it renders whatever the source happened to store.
   */
  it.each(SURFACES)('$what has no bare `contact?.name ?? …` fallback', ({ file }) => {
    expect(read(file)).not.toMatch(/contact\?\.name \?\? ['"]/);
  });

  /* The old `name || phone` chain, which duplicated the helper's own fallback
     in a second place — two rules for one question is how they drift apart. */
  it('the conversation report no longer chains its own phone fallback', () => {
    expect(read('src/features/report-exports/api.ts')).not.toContain(
      'c.contact?.name?.trim() || c.contact?.phone?.trim()',
    );
  });
});

describe('the helper can actually do its job', () => {
  /*
   * THE SILENT-FAILURE GUARD, and the real find of this pass.
   *
   * `ticket-ops` requested `['id', 'name', 'external_customer_id', …]` and NOT
   * `phone`. Directus returns `undefined` for a field nobody asked for, so the
   * fallback would have resolved to nothing and rendered an empty cell —
   * indistinguishable from "this customer has no name", and worse than the
   * `+966` it replaced. A fix that cannot see its own input is not a fix.
   */
  it('ticket operations fetches the phone it falls back to', () => {
    const src = read('src/features/ticket-ops/api.ts');
    /*
     * Matched across newlines on purpose. Prettier reflows a long field list
     * to one entry per line, so a single-line regex here passed when written
     * and failed the moment the formatter ran — brittle to formatting rather
     * than to behaviour, which is the wrong thing for a test to notice.
     */
    const m = src.match(/\{\s*contact:\s*\[([\s\S]*?)\]/);
    expect(m, 'the contact field list should still be there to check').not.toBeNull();
    expect(m![1]).toContain("'phone'");
  });

  it.each([
    { file: 'src/features/performance/AgentPerformancePage.tsx', what: 'agent performance' },
    { file: 'src/features/report-exports/api.ts', what: 'reports' },
  ])('$what fetches the phone too', ({ file }) => {
    /* Multiline-tolerant: prettier may reflow a long field list. */
    expect(read(file)).toMatch(/\{\s*contact:\s*\[[\s\S]*?'phone'/);
  });
});

describe('a name that is only a phone number is not printed twice', () => {
  /*
   * The coupon card shows `name · phone`, which exists to carry two different
   * facts. Most customers have no real name, so once the "name" is normalised
   * it becomes character-for-character the phone beside it — and the card read
   * `0508315325 · 0508315325`. When there is one fact, show it once.
   */
  it('dedupes the pair when they resolve the same', () => {
    const src = read('src/features/coupon-approvals/CouponApprovalsPage.tsx');
    expect(src).toContain("name === phone ? '' : name");
  });
});

describe('search still matches what the user pastes', () => {
  /*
   * DELIBERATELY RAW. An agent may paste `+966508315325` from WhatsApp or
   * `0508315325` from the CRM, and the haystack holds both the stored value
   * and the normalised one so either finds the row. Normalising the haystack
   * would have made the fix break search — a worse bug than the one reported.
   */
  it('the compensation haystack keeps the stored value as well', () => {
    const src = read('src/features/coupon-approvals/AllCompensationPage.tsx');
    expect(src).toMatch(/const hay = \[[\s\S]{0,300}r\.contact\?\.name,/);
    expect(src).toMatch(/normalizePhone\(r\.contact\?\.phone/);
  });
});
