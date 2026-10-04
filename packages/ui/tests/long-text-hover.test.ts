import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE FULL VALUE ON HOVER — AND YOU CAN REACH IT TO COPY IT.
 *
 * `LongText` shows a truncated table cell's whole value in a panel. It was
 * asked for against the late-orders Reason and Action columns (ops,
 * 2026-10-04), and then corrected twice, each time for a reason worth keeping:
 *
 *   1. *"needs a modern design, looks boxy"* — a hard border and a flat fill
 *      read as a dialog bolted onto a table cell rather than the value
 *      expanding.
 *   2. *"when trying to place cursor to the complete value it stops being
 *      displayed"* — and this is the one that mattered. The whole point of
 *      showing the full text is to be able to COPY it, and the panel was
 *      unreachable: it closed the moment the pointer left the cell.
 *
 * TWO THINGS MADE IT UNREACHABLE, and the fix is both of them together — this
 * is a CSS contract, so it is asserted against the source rather than by
 * mounting, where jsdom computes no hover at all.
 */
const SRC = readFileSync(resolve(import.meta.dirname, '../src/LongText.tsx'), 'utf8');

describe('reaching the panel with the cursor', () => {
  /*
   * FAULT 1: `pointer-events-none`.
   *
   * It was there so the panel could never swallow a click meant for the row
   * beneath it — but it also means the cursor passes straight THROUGH, so the
   * panel never counts as hovered and closes as soon as the pointer leaves the
   * cell. A panel you cannot point at is a panel you cannot select text in.
   */
  it('no longer passes the pointer straight through', () => {
    /*
     * Asserted against the CODE, not the whole file. The comment above the
     * panel names `pointer-events-none` while explaining why it was removed, so
     * a file-wide search fails on the explanation — and matching quoted strings
     * does not help either, because an apostrophe in the prose ("cannot") opens
     * a false quote. Everything from the panel's `<span` onward is code.
     */
    const code = SRC.slice(SRC.indexOf('role="tooltip"'));
    expect(code).not.toContain('pointer-events-none');
  });

  /*
   * FAULT 2: THE GAP.
   *
   * A visible `mt-1.5` margin between the cell and the panel is dead space —
   * the pointer crosses it, is over neither element, and the panel closes
   * mid-journey. Replacing the margin with transparent top PADDING inside the
   * panel makes the gap part of the hover target, so the crossing is unbroken.
   */
  it('bridges the gap with padding rather than a margin', () => {
    expect(SRC).toMatch(/absolute start-0 top-full z-20 w-max max-w-sm pt-1\.5/);
    expect(SRC).not.toMatch(/top-full z-20 mt-1\.5/);
  });

  /* Hover is tracked on the WRAPPER, which contains both the cell and the
     panel — so moving from one into the other keeps it open. */
  it('tracks hover on the wrapper that holds both', () => {
    expect(SRC).toMatch(/className="group\/longtext relative inline-block max-w-full align-top"/);
    expect(SRC).toMatch(/group-hover\/longtext:visible/);
  });

  /* And the text says it is selectable, so the affordance matches the
     behaviour. */
  it('marks the text as selectable', () => {
    expect(SRC).toContain('cursor-text');
    expect(SRC).toContain('select-text');
  });

  /*
   * NOT `aria-hidden` ANY MORE. It was hidden from assistive tech while it was
   * decorative; now that it is focusable content a keyboard user reaches,
   * hiding it would announce nothing where there is something to read.
   */
  it('is not hidden from assistive technology', () => {
    expect(SRC).not.toContain('aria-hidden');
  });
});

describe('the panel still behaves like a panel', () => {
  /* Opens on FOCUS as well as hover, or a keyboard user never sees it. */
  it('opens on focus too', () => {
    expect(SRC).toMatch(/group-focus-within\/longtext:visible/);
    expect(SRC).toMatch(/tabIndex=\{0\}/);
  });

  /* Over the following rows, not clipped by them. */
  it('sits above the rows beneath it', () => {
    expect(SRC).toContain('z-20');
  });

  /* ANIMATED, not display-swapped: `hidden` cannot transition, which was half
     of why the first version felt abrupt. */
  it('fades and lifts in rather than appearing', () => {
    expect(SRC).toMatch(/invisible -translate-y-1 opacity-0/);
    expect(SRC).toMatch(/transition-\[opacity,transform,visibility\]/);
  });

  /* THE BOXINESS: a hard border gave way to the app's own elevation ramp. */
  it('uses the elevation ramp rather than a border', () => {
    expect(SRC).toContain('shadow-float');
    expect(SRC).toContain('rounded-xl');
    expect(SRC).not.toMatch(/border border-border/);
  });

  /* A blank cell must not sprout a panel, and must not be focusable — tabbing
     through a report would stop on every empty one. */
  it('renders a plain dash when there is nothing to expand', () => {
    expect(SRC).toMatch(
      /if \(!text\) return <span className="text-muted-foreground">\{empty\}<\/span>/,
    );
  });
});
