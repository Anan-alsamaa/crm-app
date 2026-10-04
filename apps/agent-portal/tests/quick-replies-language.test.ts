import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  rankReplies,
  defaultReplyLang,
  type QuickReply,
} from '../src/features/conversation/QuickReplies.js';

/**
 * SHOW THE AGENT THE REPLIES THEY CAN ACTUALLY SEND.
 *
 * Requested by operations (2026-10-03): *"we need english and arabic — Arabic
 * replies when customer is Arabic, English when customer is English. There can
 * be an option to select Arabic and English and it only displays those values
 * based on the language."*
 *
 * The `lang` column already existed and was used for RANKING only — its own
 * comment said "Ordering only. Nothing is hidden." That is not enough in
 * practice: with replies in both languages the right one is first, but the list
 * is still half wrong and an agent scanning it reads past Arabic to reach
 * English.
 *
 * So ranking stays and filtering is added on top. `'all'` is the default, which
 * is exactly the old behaviour — the existing ranking tests pass untouched.
 */

const r = (id: string, lang: 'en' | 'ar', label = id, text = `${id} body`): QuickReply => ({
  id,
  label,
  text,
  lang,
});

const SET = [r('greet-en', 'en'), r('greet-ar', 'ar'), r('bye-en', 'en'), r('bye-ar', 'ar')];

describe('filtering by language', () => {
  it('shows only Arabic when Arabic is chosen', () => {
    const out = rankReplies(SET, '', '', 'en', 'ar');
    expect(out.map((x) => x.id).sort()).toEqual(['bye-ar', 'greet-ar']);
  });

  it('shows only English when English is chosen', () => {
    const out = rankReplies(SET, '', '', 'ar', 'en');
    expect(out.map((x) => x.id).sort()).toEqual(['bye-en', 'greet-en']);
  });

  /* THE OLD BEHAVIOUR, and the default — so nothing that already worked
     changes shape. */
  it('shows both when Both is chosen', () => {
    expect(rankReplies(SET, '', '', 'en', 'all')).toHaveLength(4);
    expect(rankReplies(SET, '', '', 'en')).toHaveLength(4);
  });

  /* Filtering narrows the set; ranking still orders what survives. */
  it('still ranks within the chosen language', () => {
    const out = rankReplies([r('b-en', 'en'), r('a-en', 'en')], '', '', 'en', 'en');
    expect(out.map((x) => x.id)).toEqual(['a-en', 'b-en']);
  });

  /* The composer's "/" search must keep working inside a language. */
  it('applies the text search after the language filter', () => {
    const out = rankReplies(SET, '', 'bye', 'en', 'en');
    expect(out.map((x) => x.id)).toEqual(['bye-en']);
  });

  /*
   * AN EMPTY RESULT IS A REAL ANSWER. If every reply is English and the agent
   * picks Arabic, the honest outcome is nothing — and the UI says so and offers
   * Both, rather than silently falling back and looking like the filter is
   * broken.
   */
  it('returns nothing when the chosen language has none', () => {
    expect(rankReplies([r('only-en', 'en')], '', '', 'en', 'ar')).toEqual([]);
  });
});

describe('which language is offered first', () => {
  /* From what the CUSTOMER wrote — an Arabic template WE sent earlier must not
     make an English conversation look Arabic. */
  it('follows the customer', () => {
    expect(defaultReplyLang('السلام عليكم')).toBe('ar');
    expect(defaultReplyLang('where is my order')).toBe('en');
  });

  /* Nothing written yet is nothing to infer from. Showing both beats guessing
     and hiding half the list on the agent's first move. */
  it('shows both before the customer has written', () => {
    expect(defaultReplyLang('')).toBe('all');
    expect(defaultReplyLang('   ')).toBe('all');
  });

  /* Mixed text counts as Arabic: one Arabic word means they can read it, and a
     customer writing Arabic is the case the toggle exists for. */
  it('treats mixed text as Arabic', () => {
    expect(defaultReplyLang('order 123 متأخر')).toBe('ar');
  });
});

/**
 * THE CHOOSER ITSELF.
 *
 * Asserted against the source: the component needs a QueryClient, i18n and a
 * live Directus transport to mount, and mocking all three to observe a dropdown
 * would be testing the mocks.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/QuickReplies.tsx'),
  'utf8',
);

describe('the quick-reply chooser', () => {
  /* THE REGRESSION IT REPLACES: five pills and the rest behind "⋯ all n". */
  it('no longer caps the list at five', () => {
    expect(SRC).not.toMatch(/ranked\.slice\(0, 5\)/);
  });

  it('is a listbox, not a row of chips', () => {
    expect(SRC).toContain('role="listbox"');
    expect(SRC).toContain('aria-haspopup="listbox"');
  });

  /* The composer sits at the bottom of the window, so a menu opening downward
     opens off-screen. */
  it('opens upward from the composer', () => {
    expect(SRC).toContain('bottom-full');
  });

  /* An agent should never send something they have not read, and `title` is
     invisible on a touch screen and to a keyboard user. */
  it('shows the full text rather than a tooltip', () => {
    expect(SRC).toContain('whitespace-pre-wrap');
  });

  it('offers all three language choices', () => {
    expect(SRC).toMatch(/\['ar', 'en', 'all'\]/);
  });

  /*
   * ONE REPLY MUST LOOK LIKE ONE REPLY.
   *
   * Every row was `text-2xs` on both lines with nothing between them, so a
   * panel of replies read as a single slab of grey and an agent could not see
   * where one ended (owner, 2026-10-04). Three things separate them, and each
   * is asserted because losing any one brings the slab back.
   */
  it('separates each reply with a hairline', () => {
    expect(SRC).toMatch(/after:bg-border/);
    /* The last card has no trailing line, or the list ends on a stray rule. */
    expect(SRC).toContain('last:after:hidden');
  });

  it('makes the label outrank the body text', () => {
    /* The label is `text-xs` and the body `text-2xs`. Equal sizes is what made
       nothing stand out. */
    expect(SRC).toMatch(/text-xs font-semibold leading-tight text-foreground/);
  });

  it('lifts the whole card on hover, not just the text', () => {
    expect(SRC).toMatch(/hover:border-primary\/25/);
    expect(SRC).toMatch(/hover:bg-primary\/\[0\.05\]/);
  });

  /* A long reply must not push the rest of the list out of view. The full text
     still reaches the composer — only the preview is clamped. */
  it('clamps a long reply in the preview', () => {
    expect(SRC).toContain('line-clamp-3');
  });
});

/**
 * OPENING AND CLOSING THE PANEL (ops, 2026-10-04).
 *
 * Two complaints, one about each direction:
 *
 *   "If `/` is entered in the input field, it should search for the Quick Reply
 *    and display it."
 *   "If the user clicks anywhere outside the Quick Reply value box, it should
 *    close."
 *
 * The first was a FALSY EMPTY STRING. The composer handed down
 * `/^\/(.*)$/.exec(draft)?.[1] ?? ''`, so a bare `/` and no slash at all were
 * both `''`; the panel opened on `!!query`, and the list therefore appeared
 * only once a SECOND character was typed. A bare `/` is the whole gesture.
 *
 * The second simply did not exist — there was no dismiss handler of any kind,
 * so the only way out was the button again or picking a reply.
 */
describe('opening on a bare slash', () => {
  /* The composer must tell the panel that it is in search mode SEPARATELY from
     what has been typed, or the empty-string case is unrecoverable. */
  it('takes a searching flag distinct from the query', () => {
    expect(SRC).toMatch(/searching\?: boolean/);
    expect(SRC).toMatch(/const listOpen = open \|\| !!searching/);
  });

  /* THE REGRESSION: opening on the query alone. */
  it('no longer opens on the query alone', () => {
    expect(SRC).not.toMatch(/const listOpen = open \|\| !!query;/);
  });

  /* And the composer has to distinguish the two cases to be able to pass it. */
  it('is given a searching flag by the composer', () => {
    const view = readFileSync(
      resolve(import.meta.dirname, '../src/features/conversation/ConversationView.tsx'),
      'utf8',
    );
    expect(view).toMatch(/const replySearching = slashMatch !== null/);
    expect(view).toMatch(/searching=\{replySearching\}/);
  });
});

describe('closing when the agent clicks away', () => {
  it('dismisses on a press outside the control', () => {
    expect(SRC).toMatch(/addEventListener\('pointerdown', onDown\)/);
    expect(SRC).toMatch(/wrap\.current\?\.contains\(e\.target as Node\)/);
  });

  /* The listener is removed again, or every chat ever opened leaves one behind
     — the leak shape this codebase has already been bitten by. */
  it('removes the listener again', () => {
    expect(SRC).toMatch(/removeEventListener\('pointerdown', onDown\)/);
  });

  /* Escape is what a listbox is expected to answer to. */
  it('also dismisses on Escape', () => {
    expect(SRC).toMatch(/e\.key === 'Escape'/);
  });

  /*
   * THE LANGUAGE TOGGLE LIVES INSIDE THE CONTROL, so flipping Arabic/English
   * must not close the list the agent is reading. Asserted by the ref being on
   * the OUTER wrapper — the element that contains the toggle and the panel —
   * rather than on the panel alone.
   */
  it('keeps the ref on the wrapper that holds the toggle', () => {
    expect(SRC).toMatch(/<div ref=\{wrap\} className=\{cn\('relative', className\)\}>/);
  });

  /* Only while open: a document-wide listener armed on every conversation for
     a panel nobody opened is pure cost. */
  it('arms the listener only while open', () => {
    const fx = SRC.slice(SRC.indexOf('useEffect(() => {'), SRC.indexOf('const total ='));
    expect(fx).toMatch(/if \(!open\) return;/);
  });
});
