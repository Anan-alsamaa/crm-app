import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE MOBILE MENU SCROLLS (owner, 26 Nov 2026: "the admin portal should be able
 * to swipe down the sidebar for mobile screen size").
 *
 * The drawer is a fixed-height flex column: brand, menu, footer. A `flex-1`
 * child keeps `min-height: auto`, so without `min-h-0` the menu grows to its
 * full length instead of scrolling - the lower items sat past the bottom of
 * the screen, and the page behind is locked while the drawer is open. jsdom
 * does no layout, so this pins the classes that make it scroll.
 */
const APP = readFileSync(resolve(import.meta.dirname, '../src/App.tsx'), 'utf8');
const rail = APP.slice(APP.indexOf('function Rail('), APP.indexOf('function Rail(') + 4000);

describe('the mobile sidebar menu', () => {
  it('can shrink below its content, so it scrolls', () => {
    expect(rail).toMatch(/'min-h-0 flex-1 overflow-y-auto/);
  });

  it('keeps a swipe inside the menu', () => {
    expect(rail).toContain('overscroll-contain');
  });
});
