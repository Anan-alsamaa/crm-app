import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CLICKING AN EMOJI HAS TO SURVIVE THE DISMISS HANDLER.
 *
 * Operations, 2026-10-03: *"not a single emoji is working. on click nothing
 * happens. doesn't get written to the input field."*
 *
 * THE PICKER HAD NEVER WORKED. It was portaled to `document.body` from the day
 * it was written (`5ee339f`), while the outside-click handler asked
 * `wrap.current.contains(e.target)` — and `wrap` only ever contained the
 * TRIGGER. Every emoji button was therefore "outside", so the `mousedown`
 * listener closed the panel and React unmounted the button before its `click`
 * could fire. The click simply never happened.
 *
 * A LESSON ABOUT THE FIRST REPORT. This was first described as the sunglasses
 * emoji not inserting, and the diagnosis then was "it probably renders blank on
 * that machine" — a font problem, on one glyph. That was wrong. The word that
 * cracked it was the second report's "not a SINGLE emoji": one broken glyph is
 * a font, sixty broken glyphs is the code. A fix aimed at one symptom should
 * have been suspicious of why only one symptom was reported.
 *
 * Asserted against the SOURCE: the panel is portaled and positioned from
 * `getBoundingClientRect`, which jsdom reports as all-zero, so a rendered test
 * would be checking a layout that does not exist. What matters is that the
 * dismiss handler knows the picker lives in two places in the DOM.
 */
const SRC = readFileSync(resolve(import.meta.dirname, '../src/EmojiPicker.tsx'), 'utf8');

describe('the emoji picker dismiss handler', () => {
  /* THE REGRESSION ITSELF: the panel needs its own ref, because it is not
     inside the wrapper. */
  it('holds a ref to the portaled panel', () => {
    expect(SRC).toMatch(/const panelRef = useRef<HTMLDivElement>\(null\)/);
    expect(SRC).toMatch(/ref=\{panelRef\}/);
  });

  it('treats a click inside the panel as inside the picker', () => {
    expect(SRC).toMatch(/wrap\.current\?\.contains\(t\) \|\| panelRef\.current\?\.contains\(t\)/);
  });

  /* The old test — `wrap` alone — is what closed the panel on every emoji. */
  it('no longer asks only about the wrapper', () => {
    expect(SRC).not.toMatch(
      /if \(wrap\.current && !wrap\.current\.contains\(e\.target as Node\)\)/,
    );
  });

  /*
   * STILL `mousedown`, deliberately. Closing on `click` would let the panel
   * survive a press that lands outside it, which is the behaviour the listener
   * exists to prevent. The fix is that the handler now knows about both halves
   * of the picker — not that it fires later.
   */
  it('still dismisses on mousedown', () => {
    expect(SRC).toContain("document.addEventListener('mousedown', onDown)");
  });

  /* And the panel is still portaled — the fix accommodates that rather than
     undoing it. The panel must escape the composer's overflow clipping. */
  it('keeps the panel in a portal', () => {
    expect(SRC).toContain('createPortal');
    expect(SRC).toContain('document.body');
  });
});
