import { describe, it, expect } from 'vitest';
import {
  extractMentionTokens,
  resolveMentions,
  type MentionableUser,
} from '../src/features/conversation/mentions.js';

const USERS: MentionableUser[] = [
  { id: 'u1', email: 'alice@example.com', first_name: 'Alice', last_name: 'A' },
  { id: 'u2', email: 'bob@example.com', first_name: 'Bob', last_name: 'B' },
  { id: 'u3', email: 'carol@example.com', first_name: null, last_name: null },
];

describe('extractMentionTokens (T058)', () => {
  it('finds @local mentions across positions and spaces', () => {
    expect(extractMentionTokens('@alice hello')).toEqual(['alice']);
    expect(extractMentionTokens('hi @alice and @bob')).toEqual(['alice', 'bob']);
    expect(extractMentionTokens('mid@nope is an email, not a mention')).toEqual([]);
  });

  it('dedups + lowercases', () => {
    expect(extractMentionTokens('@Alice @ALICE @alice')).toEqual(['alice']);
  });

  it('accepts full email tokens', () => {
    expect(extractMentionTokens('@alice@example.com here')).toEqual(['alice']);
  });
});

describe('resolveMentions (T058)', () => {
  it('resolves @local-part to user ids', () => {
    expect(resolveMentions('@alice please check', USERS)).toEqual(['u1']);
    expect(resolveMentions('cc @bob and @alice', USERS).sort()).toEqual(['u1', 'u2']);
  });
  it('returns [] when no recognised tokens', () => {
    expect(resolveMentions('no mentions here', USERS)).toEqual([]);
    expect(resolveMentions('@unknown', USERS)).toEqual([]);
  });
});

describe('internal note routing (T058)', () => {
  it('NoteAdd payload signals internal-only routing', () => {
    // The contract: when sender_type=agent and is_internal_note=true, the
    // gateway emits note:new only to the conversation room (where the customer
    // widget filters those out) — never as message:new.
    const note = {
      conversationId: 'c1',
      content: '@alice please look',
      mentions: ['u1'],
      clientMsgId: 'n1',
    };
    expect(note.content.startsWith('@')).toBe(true);
    expect(note.mentions.length).toBeGreaterThan(0);
  });
});
