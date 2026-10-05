import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A PRIMARY ACTION DARKENS WHEN YOU REACH FOR IT.
 *
 * Owner, 2026-10-05, about the late-orders Search button:
 *
 *   "should be the purplish color that we have for a selected button. on
 *    selection should be 1 shade dark on hover and click. right now the
 *    search button being gray is not very visible."
 *
 * Two faults in one report. The button was `variant="secondary"` — the same
 * muted grey as the filter labels around it, so the one control that actually
 * runs the query looked like chrome. And the `brand` variant it should have
 * been used `hover:bg-primary/90`, which lowers OPACITY: on a light background
 * that blends the fill toward the page, so the button appears to fade as the
 * pointer lands on it. The opposite of press feedback.
 *
 * `--primary-strong` is the same hue at lower lightness (0.4 vs 0.457), so it
 * is a genuine darker shade rather than a transparency trick, and the dark
 * theme defines its own pair so the gesture survives the theme flip.
 */
const BUTTON = readFileSync(resolve(import.meta.dirname, '../src/Button.tsx'), 'utf8');

/** Just the `brand` variant's class string. */
const brandVariant = (): string => {
  const m = BUTTON.match(/\n {2}brand:\n([\s\S]*?),\n {2}secondary:/);
  expect(m, 'the brand variant should still be declared before secondary').not.toBeNull();
  return m![1];
};

describe('the brand button darkens on hover and press', () => {
  it('fills with the brand colour', () => {
    expect(brandVariant()).toContain('bg-primary ');
  });

  /* THE FIX: a real darker shade on hover. */
  it('hovers to the darker shade, not a faded one', () => {
    expect(brandVariant()).toContain('hover:bg-primary-strong');
  });

  /*
   * THE REGRESSION GUARD. `hover:bg-primary/90` is what was there, and it is
   * the kind of change that reads as harmless in review — it still mentions
   * the brand colour. Named explicitly so reintroducing it fails here.
   */
  it('never lowers opacity on hover', () => {
    expect(brandVariant()).not.toMatch(/hover:bg-primary\/\d+/);
  });

  /* The press itself gets its own state, so a click is felt and not only
     inferred from the hover that preceded it. */
  it('darkens on the press too', () => {
    expect(brandVariant()).toContain('active:bg-primary-strong');
  });

  /*
   * `bg-primary-strong` only exists because the Tailwind preset maps it. If
   * that mapping is dropped the class silently becomes a no-op and the hover
   * stops changing anything — with no error anywhere.
   */
  it('is backed by a real Tailwind token', () => {
    const preset = readFileSync(resolve(import.meta.dirname, '../tailwind-preset.cjs'), 'utf8');
    expect(preset).toContain('var(--primary-strong)');
  });
});

describe('the late-orders Search button', () => {
  const PAGE = readFileSync(
    resolve(
      import.meta.dirname,
      '../../../apps/agent-portal/src/features/late-orders/LateOrdersPage.tsx',
    ),
    'utf8',
  );

  /** The Search button's own JSX. */
  const searchButton = (): string => {
    const m = PAGE.match(/<Button\n[\s\S]{0,400}?lateOrders\.filter\.apply[\s\S]{0,80}?<\/Button>/);
    expect(m, 'the Search button should still render the apply label').not.toBeNull();
    return m![0];
  };

  it('uses the brand fill', () => {
    expect(searchButton()).toContain('variant="brand"');
  });

  /* It was grey, and grey is what the report was about. */
  it('is not the muted secondary any more', () => {
    expect(searchButton()).not.toContain('variant="secondary"');
  });

  /*
   * STILL DISABLED UNTIL THE RANGE IS VALID. A brand-filled button is louder,
   * so losing this guard would mean a prominent control that fires an invalid
   * query — worse than the grey it replaced.
   */
  it('stays disabled until both dates are set and ordered', () => {
    expect(searchButton()).toContain('disabled={!draftFrom || !draftTo || draftFrom > draftTo}');
  });
});
