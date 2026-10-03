import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CLICKING AN EMOJI MUST PUT IT WHERE THE AGENT CAN SEE IT.
 *
 * Reported by operations (2026-10-03) against the sunglasses face: *"button is
 * visible, on click nothing comes"*.
 *
 * It was not about that emoji. 😎 is `U+1F60E`, a plain single-codepoint
 * character — less exotic than ❤️ or 🍽️, which carry a variation selector and
 * insert fine. Every one of the 60 entries was decoded and the array is sound.
 *
 * THE REAL FAULT was that `insertEmoji` called `setDraft` directly instead of
 * going through `onDraftChange`. The composer is `rows={1}` and its height is
 * set IMPERATIVELY — only `onDraftChange` measures `scrollHeight` and grows the
 * box. So the emoji was stored correctly and the textarea stayed one line tall:
 * on a draft that already filled that line the character landed below the clip.
 * Really inserted, genuinely invisible, and indistinguishable from a dead
 * button — which is why it was reported as one.
 *
 * Asserted against the SOURCE: the composer needs a conversation, a socket, a
 * QueryClient and an auth context to mount, and jsdom reports `scrollHeight: 0`
 * for every element, so a rendered test could not observe the resize it is
 * checking for. What matters is that insertion keeps going through the one
 * function that resizes.
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');
const VIEW = read('src/features/conversation/ConversationView.tsx');

describe('inserting an emoji', () => {
  /* THE REGRESSION ITSELF. */
  it('goes through onDraftChange, which resizes the box', () => {
    expect(VIEW).toMatch(/onDraftChange\(next, at \+ emoji\.length\)/);
  });

  it('no longer calls setDraft directly', () => {
    const body = VIEW.slice(VIEW.indexOf('const insertEmoji'));
    const fn = body.slice(0, body.indexOf('const insertQuickReply'));
    expect(fn).not.toMatch(/setDraft\(next\)/);
  });

  /* The caret still lands AFTER the emoji so typing continues naturally, and
     the box is re-focused because the click took focus to the picker. */
  it('still restores focus and the caret', () => {
    const body = VIEW.slice(VIEW.indexOf('const insertEmoji'));
    const fn = body.slice(0, body.indexOf('const insertQuickReply'));
    expect(fn).toContain('box.focus()');
    expect(fn).toMatch(/setSelectionRange\(caret, caret\)/);
  });

  /* `emoji.length`, not 1: a multi-codepoint entry such as ❤️ or 🍽️ is two or
     three UTF-16 units, and a hardcoded 1 would drop the caret inside the
     character. */
  it('advances the caret by the emoji’s real length', () => {
    expect(VIEW).toMatch(/const caret = at \+ emoji\.length/);
  });
});

/**
 * And the one it was reported against must still be in the picker, spelled the
 * ordinary way.
 */
const PICKER = readFileSync(
  resolve(import.meta.dirname, '../../../packages/ui/src/EmojiPicker.tsx'),
  'utf8',
);

describe('the emoji set', () => {
  it('still offers the sunglasses face', () => {
    expect(PICKER).toContain('\u{1F60E}');
  });

  /* A duplicate would collide on React's `key={e}` and drop a button. */
  it('has no duplicates', () => {
    const glyphs = [...PICKER.matchAll(/'([^']+)'/g)]
      .map((m) => m[1]!)
      .filter((s) => /\p{Extended_Pictographic}/u.test(s));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
