import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ENHANCE OFFERS A SUGGESTION. IT DOES NOT TAKE THE AGENT'S WORDS AWAY.
 *
 * Asked for 2026-10-04: *"The agent will enter text in the input field and
 * click Enhance. The AI should then suggest a better reply based on the entered
 * text."* — and, having seen the first cut: *"the enhance on click should
 * display the suggestion in a separate field as a reply from AI, and should not
 * replace the text in the input text field."*
 *
 * That correction is the whole design, and it is worth stating why it is right
 * rather than merely requested. The first version wrote the suggestion straight
 * into the composer and offered Ctrl+Z. An agent then loses what they wrote the
 * instant they press the button, has to read the replacement to discover
 * whether it was an improvement, and has to remember an undo to get back. A
 * suggestion is a PROPOSAL: it belongs beside the draft where both can be read
 * together, and it reaches the composer only when the agent says so.
 *
 * Asserted against the source. The component needs a QueryClient, i18n, an auth
 * context and a live AI gateway to mount, and mocking all four to watch one
 * state transition would be testing the mocks.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/EnhanceButton.tsx'),
  'utf8',
);
const VIEW = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/ConversationView.tsx'),
  'utf8',
);

describe('the suggestion is held, not written', () => {
  /* THE REGRESSION: writing straight through on success. */
  it('does not push the reply into the composer on arrival', () => {
    expect(SRC).not.toMatch(/onSuccess:[\s\S]{0,200}onEnhanced\(text\)/);
  });

  it('holds the suggestion in its own state', () => {
    expect(SRC).toMatch(/const \[suggestion, setSuggestion\] = useState<string \| null>\(null\)/);
    expect(SRC).toMatch(/setSuggestion\(text\)/);
  });

  /* The composer is told ONLY when the agent accepts. */
  it('reaches the composer only through an explicit accept', () => {
    expect(SRC).toMatch(/onAccept: \(text: string\) => void/);
    expect(SRC).toMatch(/onAccept\(suggestion\)/);
  });

  it('is wired to the composer as onAccept', () => {
    expect(VIEW).toMatch(/onAccept=\{applyEnhanced\}/);
  });
});

describe('the suggestion card', () => {
  /* ATTRIBUTED. The agent has to be able to tell at a glance that these are
     not their own words. */
  it('is labelled as the AI speaking', () => {
    expect(SRC).toContain('ai.suggestionTitle');
    expect(SRC).toMatch(/role="region"/);
  });

  /* The composer sits at the bottom of the window, so a panel opening downward
     opens off-screen — the same rule the quick-replies list follows. */
  it('opens upward from the composer', () => {
    expect(SRC).toContain('bottom-full');
  });

  /* THE WHOLE TEXT, scrollable rather than clamped: an agent must never send
     something they have not read, and this is about to become their reply. */
  it('shows the full suggestion rather than a truncation', () => {
    expect(SRC).toContain('whitespace-pre-wrap');
    expect(SRC).toContain('overflow-y-auto');
    expect(SRC).not.toContain('line-clamp');
  });

  it('offers accept, dismiss and try-again', () => {
    expect(SRC).toContain('ai.useSuggestion');
    expect(SRC).toContain('actions.dismiss');
    expect(SRC).toContain('ai.regenerate');
  });

  /* Dismissing costs nothing — the draft was never touched, so there is
     nothing to restore. */
  it('dismisses by clearing the suggestion alone', () => {
    expect(SRC).toMatch(/onClick=\{\(\) => setSuggestion\(null\)\}/);
  });

  /*
   * TRY AGAIN RE-ASKS FROM THE SAME DRAFT — the one still in the box, exactly
   * as the agent typed it. That is only possible because accepting is a
   * separate step; with the first design the draft had already been replaced
   * by the suggestion, so a second press would have enhanced the enhancement.
   */
  it('regenerates from the untouched draft', () => {
    expect(SRC).toMatch(/\{\s*t\('ai\.regenerate'/);
    expect(SRC).toMatch(/draft,\s*\n\s*locale,/);
  });
});

describe('the button itself', () => {
  /* Nothing typed is nothing to enhance, and a disabled button cannot explain
     itself — "nothing happens" is how the emoji button was reported. */
  it('is disabled with an explanation when the draft is empty', () => {
    expect(SRC).toMatch(/const empty = draft\.trim\(\)\.length === 0/);
    expect(SRC).toMatch(/disabled=\{empty \|\| busy\}/);
    expect(SRC).toContain('ai.enhanceHint');
  });

  /* AI off for this vendor: no button at all, rather than a dead one. */
  it('renders nothing when AI is off for the vendor', () => {
    expect(SRC).toMatch(/if \(!vendorId\) return null/);
  });

  /*
   * AN EMPTY ANSWER IS A FAILURE, not a suggestion. Showing an empty card
   * would read as the feature half-working.
   */
  it('treats an empty reply as an error', () => {
    expect(SRC).toContain('ai.enhanceEmpty');
    expect(SRC).toMatch(/if \(!text\) \{/);
  });
});

/**
 * AND IT STILL LANDS THROUGH `onDraftChange`.
 *
 * The composer is `rows={1}` and its height is set imperatively — only
 * `onDraftChange` measures `scrollHeight` and grows the box. `setDraft` alone
 * stores the text and leaves one line tall, which is what made the emoji button
 * look dead (2026-10-03) and would bite harder here: an enhanced reply is
 * usually longer than the draft it replaces.
 */
describe('accepting a suggestion', () => {
  it('grows the composer instead of clipping it', () => {
    const fn = VIEW.slice(
      VIEW.indexOf('const applyEnhanced'),
      VIEW.indexOf('const undoQuickReply'),
    );
    expect(fn).toMatch(/onDraftChange\(text, text\.length\)/);
    expect(fn).not.toMatch(/setDraft\(text\)/);
  });

  /* The undo stays: "Use this" is still one click away from losing a carefully
     worded reply. */
  it('keeps the draft recoverable with Ctrl+Z', () => {
    const fn = VIEW.slice(
      VIEW.indexOf('const applyEnhanced'),
      VIEW.indexOf('const undoQuickReply'),
    );
    expect(fn).toMatch(/replacedDraftRef\.current = prior\.trim\(\) \? prior : null/);
  });
});
