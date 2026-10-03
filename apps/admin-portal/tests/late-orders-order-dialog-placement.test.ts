import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A DIALOG MUST BE RENDERED BY WHATEVER TAB OPENS IT.
 *
 * Operations, 2026-10-03, from a.dawoud@anan.sa: *"opened the late orders
 * report page, on clicking the order button nothing happens or nothing opens."*
 *
 * The `<Modal>` sat inside `{tab === 'agents' && (...)}`. The Order button that
 * opens it sits in the DECISIONS tab. So the click set `openOrder` for a dialog
 * React was not rendering, and nothing happened — no error, no console warning,
 * a button that is simply inert.
 *
 * WHY THE FIRST DIAGNOSIS WAS WRONG. This was read as a permissions problem:
 * the cell is gated on `canSeeOrder`, which named only WeCare Admin and
 * Supervisor, so a WeCare Agent would see no button at all. That gate was real
 * and worth widening — but it was not THIS. The reporter is a **WeCare Admin**,
 * who passed the old gate all along, and they said the button was THERE and did
 * nothing. "Nothing happens on click" and "the button is missing" are different
 * reports, and conflating them cost a release.
 *
 * Asserted against the SOURCE: the page needs an auth context, a QueryClient
 * and a live Directus transport to mount.
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');
const PAGE = read('src/features/late-orders/LateOrdersReportPage.tsx');

describe('the order snapshot dialog', () => {
  it('is rendered exactly once', () => {
    expect(PAGE.match(/<Modal\b/g) ?? []).toHaveLength(1);
  });

  /*
   * THE REGRESSION ITSELF. The Modal must come AFTER every tab block closes,
   * so no tab's mounting decides whether it exists. Checked by position: the
   * last `tab === ` branch has to open before the Modal does.
   */
  it('lives outside every tab branch', () => {
    const lastTab = PAGE.lastIndexOf("tab === '");
    const modal = PAGE.indexOf('<Modal');
    expect(lastTab).toBeGreaterThan(-1);
    expect(modal).toBeGreaterThan(lastTab);
  });

  /* And it must be reachable from the tab that owns the button. */
  it('is opened from the decisions tab', () => {
    const decisions = PAGE.indexOf("tab === 'decisions'");
    const button = PAGE.indexOf('setOpenOrder(r.id)');
    expect(decisions).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(decisions);
  });

  /*
   * EVERY WeCare ROLE STILL SEES THE BUTTON. Widening that gate was a real
   * improvement even though it was not this bug, and it must not be lost while
   * fixing the placement.
   */
  it('keeps the widened role gate', () => {
    expect(PAGE).toMatch(/const canSeeOrder = isOwner \|\|/);
    expect(PAGE).toMatch(/\/\^WeCare\\b\/i\.test/);
  });
});
