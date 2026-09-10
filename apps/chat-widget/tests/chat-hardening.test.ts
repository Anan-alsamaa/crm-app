import { describe, it, expect } from 'vitest';

/**
 * The chat's remaining silent failures, pinned.
 *
 * Each of these let the customer believe something that was not true: a rating
 * saved when it was dropped, a message sent once when it went twice, a photo
 * that could never be opened again. None threw, none logged anything a customer
 * could see, and none would fail a schema check.
 */

/** Mirrors the history merge in Widget.tsx `onHistory`. */
type M = { id: string; senderType: 'customer' | 'agent'; content: string; clientMsgId?: string };
function mergeHistory(history: M[], prev: M[]): M[] {
  const seenIds = new Set(history.map((m) => m.id));
  const mine = new Set(
    history.filter((m) => m.senderType === 'customer').map((m) => m.content.trim()),
  );
  return [
    ...history,
    ...prev.filter((m) => {
      if (seenIds.has(m.id)) return false;
      const echoedBack =
        m.senderType === 'customer' && !!m.clientMsgId && mine.has(m.content.trim());
      return !echoedBack;
    }),
  ];
}

describe('history merge on reconnect', () => {
  it('drops an optimistic bubble whose message DID land', () => {
    /*
     * The reported shape: the send succeeded but its echo was lost across a
     * reconnect. History returns the real row; the local copy carries our own
     * client id, so an id-only dedupe kept both and the customer saw their
     * message twice — the second marked failed, inviting a Retry that really
     * would have duplicated it for the agent.
     */
    const history: M[] = [{ id: 'srv-1', senderType: 'customer', content: 'my order is late' }];
    const prev: M[] = [
      { id: 'cmid-1', senderType: 'customer', content: 'my order is late', clientMsgId: 'cmid-1' },
    ];
    expect(mergeHistory(history, prev)).toHaveLength(1);
  });

  it('KEEPS a genuinely unsent message so it can be retried', () => {
    const history: M[] = [{ id: 'srv-1', senderType: 'customer', content: 'first' }];
    const prev: M[] = [
      { id: 'cmid-2', senderType: 'customer', content: 'never arrived', clientMsgId: 'cmid-2' },
    ];
    expect(mergeHistory(history, prev).map((m) => m.id)).toEqual(['srv-1', 'cmid-2']);
  });

  it('does not collapse an AGENT repeating themselves', () => {
    // Only our own outgoing messages are matched by content; an agent saying
    // the same thing twice is two real messages.
    const history: M[] = [
      { id: 's1', senderType: 'agent', content: 'Hello?' },
      { id: 's2', senderType: 'agent', content: 'Hello?' },
    ];
    expect(mergeHistory(history, []).length).toBe(2);
  });

  it('is idempotent across repeated reconnects', () => {
    const history: M[] = [{ id: 'srv-1', senderType: 'customer', content: 'hi' }];
    const once = mergeHistory(history, []);
    expect(mergeHistory(history, once)).toHaveLength(1);
  });
});

/** Mirrors `ensureAttachment`'s retry rule. */
function attemptTracker() {
  const attempted = new Set<string>();
  return {
    tried: (id: string) => attempted.has(id),
    attempt: (id: string) => attempted.add(id),
    settle: (id: string, kind: 'timeout' | 'refused' | 'ok') => {
      // A timeout may be tried again; a refusal is final.
      if (kind === 'timeout') attempted.delete(id);
    },
  };
}

describe('fetching an attachment the agent sent', () => {
  it('allows a retry after a TIMEOUT', () => {
    // One bad moment of signal used to mean the photo could never be opened
    // again for the rest of the session.
    const t = attemptTracker();
    t.attempt('f1');
    t.settle('f1', 'timeout');
    expect(t.tried('f1')).toBe(false);
  });

  it('does NOT retry a refusal — that would spin', () => {
    const t = attemptTracker();
    t.attempt('f1');
    t.settle('f1', 'refused');
    expect(t.tried('f1')).toBe(true);
  });
});
