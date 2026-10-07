import { describe, it, expect } from 'vitest';
import { messageSourceFields } from '../src/message-source.js';

/** Where a message's words came from (owner, 2026-10-07). */
describe('messageSourceFields', () => {
  const agent = { senderType: 'agent' as const, senderUser: 'u1', content: 'Hello' };

  it('labels customer, system, note and the automatic welcome', () => {
    expect(messageSourceFields({ senderType: 'customer', content: 'hi' }).source).toBe('customer');
    expect(messageSourceFields({ senderType: 'system', content: 'x' }).source).toBe('system');
    expect(messageSourceFields({ ...agent, isInternalNote: true }).source).toBe('internal_note');
    expect(messageSourceFields({ ...agent, senderUser: null }).source).toBe('auto_welcome');
  });

  it('is "typed" when the composer inserted nothing', () => {
    expect(messageSourceFields(agent)).toEqual({
      source: 'typed',
      quick_reply_id: null,
      source_text: null,
      source_edited: null,
    });
  });

  it('records the quick reply, its text, and that it was sent unchanged', () => {
    expect(
      messageSourceFields({
        ...agent,
        content: 'Hello  ',
        origin: { source: 'quick_reply', quickReplyId: 'qr9', text: 'Hello' },
      }),
    ).toEqual({
      source: 'quick_reply',
      quick_reply_id: 'qr9',
      source_text: 'Hello',
      source_edited: false,
    });
  });

  it('records an AI suggestion the agent changed before sending', () => {
    const f = messageSourceFields({
      ...agent,
      content: 'Hello, your order is on its way.',
      origin: { source: 'ai_suggestion', quickReplyId: 'ignored', text: 'Hello.' },
    });
    expect(f).toEqual({
      source: 'ai_suggestion',
      quick_reply_id: null,
      source_text: 'Hello.',
      source_edited: true,
    });
  });

  it('never lets a customer claim an origin', () => {
    expect(
      messageSourceFields({
        senderType: 'customer',
        content: 'x',
        origin: { source: 'quick_reply', text: 'x' },
      }).source,
    ).toBe('customer');
  });
});
