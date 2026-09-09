import { describe, it, expect, beforeEach } from 'vitest';

/**
 * What a canned reply does to whatever is already in the composer.
 *
 * REPORTED FROM PRODUCTION (owner, 2026-09-09): clicking a canned reply added a
 * new line instead of replacing what was there. Half of that was already fixed
 * — a canned reply picked over a PREVIOUS canned reply swapped correctly — but
 * anything the agent had typed was appended to, on the reasoning that a
 * mis-click must never cost a half-written sentence.
 *
 * In practice that made the row untrustworthy in the other direction: type a
 * few words, reach for the canned version, and you get both glued together and
 * delete your own sentence by hand. Replacing is what the button looks like it
 * does, so it is what it does — and the mis-click worry is answered by making
 * the replacement undoable rather than by refusing to replace.
 *
 * The logic is extracted here rather than driven through the whole
 * ConversationView: it is a pure state transition, and testing it directly is
 * what makes the four cases below readable as a specification.
 */

/** Mirrors `insertQuickReply` + `undoQuickReply` in ConversationView.tsx. */
function makeComposer(initial = '') {
  let draft = initial;
  let lastQuickReply: string | null = null;
  let replaced: string | null = null;
  let announced = 0;

  return {
    get draft() {
      return draft;
    },
    /** How many times the agent was told their text had been taken. */
    get announced() {
      return announced;
    },
    type(text: string) {
      draft = text;
    },
    pick(text: string) {
      const base = draft.trimEnd();
      const tookRealWork = !!base && base !== lastQuickReply;
      replaced = tookRealWork ? draft : null;
      if (tookRealWork) announced += 1;
      lastQuickReply = text;
      draft = text;
    },
    undo(): boolean {
      if (replaced === null) return false;
      draft = replaced;
      replaced = null;
      lastQuickReply = null;
      return true;
    },
  };
}

describe('picking a canned reply', () => {
  let c: ReturnType<typeof makeComposer>;
  beforeEach(() => {
    c = makeComposer();
  });

  it('fills an empty composer', () => {
    c.pick('Thanks for reaching out.');
    expect(c.draft).toBe('Thanks for reaching out.');
    // Nothing was taken, so nothing to announce.
    expect(c.announced).toBe(0);
  });

  it('REPLACES a previous canned reply rather than stacking', () => {
    // "Not that one, this one" is the whole reason an agent picks a second.
    c.pick('Thanks for reaching out.');
    c.pick('Sorry about that — let me check.');
    expect(c.draft).toBe('Sorry about that — let me check.');
    expect(c.draft).not.toContain('Thanks for reaching out.');
    // Swapping our own canned text is not "taking their work".
    expect(c.announced).toBe(0);
  });

  it('REPLACES text the agent typed — the reported bug', () => {
    c.type('hi there, I was about to say');
    c.pick('Thanks for reaching out.');
    expect(c.draft).toBe('Thanks for reaching out.');
    expect(c.draft).not.toContain('hi there');
    // And it is not silent: taking somebody's sentence must be visible.
    expect(c.announced).toBe(1);
  });

  it('never leaves the two glued together on separate lines', () => {
    // The exact shape of the report: "adds a new line".
    c.type('customer asked about the refund');
    c.pick('Your refund is on its way.');
    expect(c.draft.split('\n')).toHaveLength(1);
  });

  it('gives typed text back on undo', () => {
    c.type('half a sentence I still want');
    c.pick('Thanks for reaching out.');
    expect(c.undo()).toBe(true);
    expect(c.draft).toBe('half a sentence I still want');
  });

  it('has nothing to undo when it took nothing', () => {
    // An empty composer, or a swap of our own canned text: the agent lost
    // nothing, so Ctrl+Z must fall through to the browser's own undo.
    c.pick('Thanks for reaching out.');
    expect(c.undo()).toBe(false);

    c.pick('Sorry about that.');
    expect(c.undo()).toBe(false);
  });

  it('undoes only the most recent replacement, once', () => {
    c.type('mine');
    c.pick('canned one');
    expect(c.undo()).toBe(true);
    expect(c.draft).toBe('mine');
    // A second press has nothing left of ours to restore.
    expect(c.undo()).toBe(false);
  });

  it('treats whitespace as empty, not as work worth keeping', () => {
    c.type('   \n  ');
    c.pick('Thanks for reaching out.');
    expect(c.draft).toBe('Thanks for reaching out.');
    expect(c.announced).toBe(0);
  });
});
