import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A STATUS FILTER WHERE THE OTHER FILTERS ARE.
 *
 * EMA-31 was reported, built and shipped — and reported again, because what
 * was asked for and what was delivered were not the same thing.
 *
 *   2026-10-04  "Need to add filter for ticket status to show open one in
 *                user portal"
 *   2026-10-05  "along with the filters for agent, ticket type, we also need
 *                a status filter."
 *
 * The second message is the specification. Status WAS filterable — as counted
 * tiles in the left rail — so the first report was closed in good faith. But
 * the toolbar holds Agent, Ticket type and a date range, and an agent
 * narrowing down by agent and type looks for status in that same row. Finding
 * nothing there, they report it missing. Twice.
 *
 * The lesson worth keeping: "it is technically reachable" is not the same as
 * "it is where somebody looks for it", and a feature reported twice is a
 * feature whose FIRST fix answered the wrong question.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/tickets/TicketsPage.tsx'),
  'utf8',
);

describe('the status dropdown in the toolbar', () => {
  it('exists, bound to the status filter state', () => {
    expect(SRC).toMatch(/aria-label=\{t\('tickets\.statusLabel'/);
    expect(SRC).toMatch(
      /value=\{filter\}\s*\n\s*onChange=\{\(v\) => setFilter\(v as TicketFilter\)\}/,
    );
  });

  /*
   * THE SAME STATE AS THE TILES, not a second source of truth. Two controls
   * answering one question must agree: picking "Open" in the menu lights the
   * Open tile, and vice versa. A private `useState` here would let the rail
   * and the toolbar disagree about what the table below is showing.
   */
  it('drives the same state the rail tiles set', () => {
    const tiles = SRC.match(/onClick=\{\(\) => setFilter\(/g) ?? [];
    expect(tiles.length).toBeGreaterThan(0);
    expect(SRC).not.toMatch(/useState<TicketFilter>\([^)]*\);[\s\S]*useState<TicketFilter>\(/);
  });

  /*
   * SOLVED IS OFFERED. It is deliberately absent from the TILES — a counted
   * tile for finished work is not what somebody scans a queue for — but a
   * status menu that cannot answer "show me what we closed" fails the most
   * common supervisor question.
   */
  it('offers every status including solved, and overdue', () => {
    const block = SRC.match(/const STATUS_FILTERS = \[([\s\S]*?)\] as const/);
    expect(block).not.toBeNull();
    const listed = block![1];
    for (const s of ['open', 'pending', 'solved', 'overdue']) {
      expect(listed).toContain(`'${s}'`);
    }
  });

  /* `all` is the placeholder row, not a status — it must not appear twice. */
  it('does not list "all" as a status', () => {
    const block = SRC.match(/const STATUS_FILTERS = \[([\s\S]*?)\] as const/);
    expect(block![1]).not.toContain("'all'");
    expect(SRC).toMatch(/value: 'all', label: t\('tickets\.anyStatus'/);
  });

  /*
   * ONE WORDING PER STATUS. The tiles render `t('status.<f>', { ns: 'common' })`
   * and the menu must use the identical keys — hardcoding "Open" here would
   * read correctly in English and leave the Arabic portal showing one status
   * two different ways on one screen.
   */
  it("reuses the tiles' own translation keys", () => {
    expect(SRC).toMatch(
      /\.\.\.STATUS_FILTERS\.map\(\(f\) => \(\{[\s\S]*?t\(`status\.\$\{f\}`, \{ ns: 'common' \}\)/,
    );
    expect(SRC).toMatch(/f === 'overdue'[\s\S]*?t\('tickets\.overdue'/);
  });

  /* The count travels with the label, so the menu says how much work each
     status holds without the agent having to pick it to find out. */
  it('shows a count beside each status', () => {
    expect(SRC).toMatch(/\(\$\{filterCount\(f\)\}\)/);
  });
});

describe('the status filter is translated', () => {
  it.each(['en', 'ar'])('%s carries both new strings', (lng) => {
    const json = JSON.parse(
      readFileSync(resolve(import.meta.dirname, `../src/i18n/${lng}.json`), 'utf8'),
    ) as { tickets: Record<string, string> };
    expect(json.tickets.anyStatus?.trim()).toBeTruthy();
    expect(json.tickets.statusLabel?.trim()).toBeTruthy();
  });

  /* Arabic must be Arabic. A copied English string passes a
     "key exists" check and ships an untranslated control. */
  it('the Arabic strings are actually Arabic', () => {
    const ar = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../src/i18n/ar.json'), 'utf8'),
    ) as { tickets: Record<string, string> };
    expect(ar.tickets.anyStatus).toMatch(/[؀-ۿ]/);
    expect(ar.tickets.statusLabel).toMatch(/[؀-ۿ]/);
  });
});
