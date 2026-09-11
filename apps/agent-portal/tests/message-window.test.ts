import { describe, it, expect } from 'vitest';

/**
 * WHICH END OF A LONG THREAD THE AGENT SEES.
 *
 * `useMessages` read `limit: -1` — every message a customer had ever sent,
 * fetched before the thread would render. Harmless at today's volume (the
 * longest real thread is 85 messages) and unbounded by construction.
 *
 * Bounding it is only safe in one direction. Ascending + limit keeps the
 * OLDEST N and buries the message the agent opened the chat to read — the
 * gateway's own history loader documents having made exactly that mistake.
 */
const CAP = 500;

/** Mirrors the query: newest-first, capped, then reversed for display. */
function windowed(all: Array<{ id: number }>): Array<{ id: number }> {
  const newestFirst = [...all].sort((a, b) => b.id - a.id).slice(0, CAP);
  return newestFirst.reverse();
}

describe('the agent message window', () => {
  it('keeps the NEWEST messages when a thread exceeds the cap', () => {
    const all = Array.from({ length: 600 }, (_, i) => ({ id: i + 1 }));
    const shown = windowed(all);
    expect(shown).toHaveLength(CAP);
    // The most recent message — the reason the agent opened the chat.
    expect(shown.at(-1)).toEqual({ id: 600 });
    expect(shown[0]).toEqual({ id: 101 });
  });

  it('renders oldest-to-newest, the way a conversation reads', () => {
    const shown = windowed(Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })));
    expect(shown.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves a short thread completely intact', () => {
    // The common case: 85 messages is the longest thread measured on staging.
    const all = Array.from({ length: 85 }, (_, i) => ({ id: i + 1 }));
    expect(windowed(all)).toHaveLength(85);
  });

  it('never drops the last message, whatever the length', () => {
    for (const n of [1, 499, 500, 501, 5000]) {
      const all = Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
      expect(windowed(all).at(-1)).toEqual({ id: n });
    }
  });
});
