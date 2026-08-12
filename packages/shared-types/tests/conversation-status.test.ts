import { describe, it, expect } from 'vitest';
import {
  ConversationStatus,
  RETIRED_CONVERSATION_STATUS,
  normaliseConversationStatus,
} from '../src/enums.js';

/**
 * A chat has two states. The risk in narrowing an enum is not a type error, it
 * is the rows already in the database: a conversation still holding `resolved`
 * matches no filter, so it does not error, it disappears from the inbox.
 *
 * These pin the mapping that scripts/migrate-conversation-status.mjs applies and
 * that every read path falls back to.
 */
describe('ConversationStatus', () => {
  it('has exactly the two states agents can choose', () => {
    expect(ConversationStatus.options).toEqual(['open', 'solved']);
  });

  it('rejects the retired values so nothing can write one back', () => {
    for (const retired of ['pending', 'resolved', 'closed']) {
      expect(ConversationStatus.safeParse(retired).success).toBe(false);
    }
  });
});

describe('normaliseConversationStatus', () => {
  it('passes the two live values through unchanged', () => {
    expect(normaliseConversationStatus('open')).toBe('open');
    expect(normaliseConversationStatus('solved')).toBe('solved');
  });

  it('maps a chat that was still being worked back to open', () => {
    // `pending` meant "waiting on someone" — that is work in progress, not a
    // finished case, so it must not land in the solved bucket and quietly
    // inflate resolution numbers.
    expect(normaliseConversationStatus('pending')).toBe('open');
  });

  it('maps both finished values to solved', () => {
    expect(normaliseConversationStatus('resolved')).toBe('solved');
    expect(normaliseConversationStatus('closed')).toBe('solved');
  });

  it('treats an unknown or missing value as open, never as solved', () => {
    // Defaulting the other way would mark a live customer's chat finished and
    // drop it out of the queue, which is the expensive direction to be wrong in.
    expect(normaliseConversationStatus(null)).toBe('open');
    expect(normaliseConversationStatus(undefined)).toBe('open');
    expect(normaliseConversationStatus('')).toBe('open');
    expect(normaliseConversationStatus('something-else')).toBe('open');
  });

  it('covers every retired value it publishes', () => {
    // Keeps the table and the function honest with each other: adding a key to
    // one without the other is how a value silently stops being handled.
    for (const [from, to] of Object.entries(RETIRED_CONVERSATION_STATUS)) {
      expect(normaliseConversationStatus(from)).toBe(to);
      expect(ConversationStatus.options).toContain(to);
    }
  });
});
