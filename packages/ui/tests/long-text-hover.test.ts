import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE FULL VALUE ON HOVER — AND YOU CAN REACH IT TO SELECT AND COPY IT.
 *
 * `LongText` shows a truncated table cell's whole value. Asked for against the
 * late-orders Reason and Action columns (ops, 2026-10-04) and corrected twice,
 * the second time because the panel was still unreachable:
 *
 *   *"it works. but im not able to select it"*
 *
 * ## Why the first two attempts could not have worked
 *
 * Both positioned the panel `absolute`, inside the cell. These cells live in
 * `TableSurface`, whose own comment spells out the trap: **CSS turns
 * `overflow-y: visible` into `auto` the moment `overflow-x` is `auto`**, so a
 * horizontally scrolling table is a vertical scroll container too. An
 * absolutely-positioned child is laid out inside that box and is therefore
 * CLIPPED by it. No `z-index` escapes an ancestor's overflow.
 *
 * So the panel is PORTALLED to `document.body` and positioned from the cell's
 * measured rect — and because a CSS `group-hover` cannot span a portal, the
 * open state became real state.
 *
 * Asserted against the source: jsdom computes no layout, so a mounted test
 * could not tell a clipped panel from a visible one — which is exactly the
 * failure this is guarding against.
 */
const SRC = readFileSync(resolve(import.meta.dirname, '../src/LongText.tsx'), 'utf8');

describe('escaping the table’s overflow', () => {
  /* THE FIX. Anything less is clipped by the scroll container. */
  it('portals the panel out of the table', () => {
    expect(SRC).toContain('createPortal');
    expect(SRC).toMatch(/document\.body,/);
  });

  /* Positioned from the cell's measured rect, in VIEWPORT coordinates, so no
     scroll maths is needed and the panel cannot drift. */
  it('positions from the measured rect, fixed to the viewport', () => {
    expect(SRC).toMatch(/getBoundingClientRect\(\)/);
    expect(SRC).toMatch(/'fixed z-50 w-max max-w-sm'/);
  });

  /* THE REGRESSIONS: both earlier attempts. */
  it('no longer positions the panel inside the cell', () => {
    expect(SRC).not.toMatch(/absolute start-0 top-full/);
    expect(SRC).not.toContain('pointer-events-none');
  });
});

describe('keeping it open long enough to use', () => {
  /*
   * A CSS `group-hover` cannot span a portal: the panel is no longer a DOM
   * descendant of the cell, so moving into it ends the hover. The panel must
   * therefore hold ITSELF open.
   */
  it('is held open by both the cell and the panel', () => {
    const panel = SRC.slice(SRC.indexOf('createPortal('));
    expect(panel).toMatch(/onMouseEnter=\{open\}/);
    expect(panel).toMatch(/onMouseLeave=\{close\}/);
    expect(SRC).not.toMatch(/group-hover\/longtext/);
  });

  /* THE GAP between cell and panel is dead space the pointer crosses while over
     neither. A grace period makes the crossing survivable; entering the panel
     cancels the close the cell just scheduled. */
  it('survives the gap between cell and panel', () => {
    expect(SRC).toMatch(/const GRACE_MS = \d+/);
    expect(SRC).toMatch(/closeTimer\.current = setTimeout/);
    expect(SRC).toMatch(/clearTimeout\(closeTimer\.current\)/);
  });

  /* And the text says it is selectable, so the affordance matches the
     behaviour. */
  it('marks the text as selectable', () => {
    expect(SRC).toContain('cursor-text');
    expect(SRC).toContain('select-text');
  });

  /*
   * `title` IS GONE. A native tooltip renders OVER the panel and covers the
   * very text you are trying to select — it was helping in the first version
   * and actively harmful once the panel became reachable.
   */
  it('does not fight itself with a native tooltip', () => {
    expect(SRC).not.toMatch(/title=\{text\}/);
  });
});

describe('not leaving a stale panel behind', () => {
  /*
   * The panel is positioned from a rect measured ONCE. Anything that moves the
   * cell would leave it floating over unrelated rows, and a stale panel is
   * worse than no panel. `capture: true` so a scroll inside the table's own
   * scrollport is heard, not only one on the window.
   */
  it('closes on scroll, resize and Escape', () => {
    expect(SRC).toMatch(/window\.addEventListener\('scroll', shut, true\)/);
    expect(SRC).toMatch(/window\.addEventListener\('resize', shut\)/);
    expect(SRC).toMatch(/e\.key === 'Escape'/);
  });

  it('removes those listeners again', () => {
    expect(SRC).toMatch(/window\.removeEventListener\('scroll', shut, true\)/);
    expect(SRC).toMatch(/document\.removeEventListener\('keydown', onKey\)/);
  });

  /* A report renders hundreds of these and every one can be scrolled out of
     existence mid-grace. */
  it('clears its timer on unmount', () => {
    expect(SRC).toMatch(
      /\(\) => \{\s*if \(closeTimer\.current\) clearTimeout\(closeTimer\.current\);/,
    );
  });
});

describe('the cell itself', () => {
  /* Opens on FOCUS as well as hover, or a keyboard user never sees it. */
  it('opens on focus too', () => {
    expect(SRC).toMatch(/onFocus=\{open\}/);
    expect(SRC).toMatch(/tabIndex=\{0\}/);
  });

  /* A blank cell must not sprout a panel, and must not be focusable — tabbing
     through a report would stop on every empty one. */
  it('renders a plain dash when there is nothing to expand', () => {
    expect(SRC).toMatch(
      /if \(!text\) return <span className="text-muted-foreground">\{empty\}<\/span>/,
    );
  });

  /* THE BOXINESS, from the first round: a hard border gave way to the app's own
     elevation ramp. */
  it('uses the elevation ramp rather than a border', () => {
    expect(SRC).toContain('shadow-float');
    expect(SRC).toContain('rounded-xl');
    expect(SRC).not.toMatch(/border border-border/);
  });
});
