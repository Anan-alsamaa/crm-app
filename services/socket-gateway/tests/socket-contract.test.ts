import { describe, it, expect } from 'vitest';
import { MessageSend, MessageNew, rooms, SOCKET_EVENTS } from '@yiji/shared-types';

describe('socket event contract (T039)', () => {
  it('MessageSend requires content and clientMsgId; conversationId is optional', () => {
    expect(
      MessageSend.safeParse({ conversationId: 'c', content: 'hi', clientMsgId: 'm1' }).success,
    ).toBe(true);
    // Neither text nor an attachment is still rejected.
    expect(MessageSend.safeParse({ conversationId: 'c', content: '' }).success).toBe(false);
    // No conversationId is VALID: a customer's first message is what creates
    // the conversation, so the widget has no id to send yet. The gateway
    // resolves it and refuses any id that is not the socket's own, so the IDOR
    // guard does not depend on this field being required here.
    expect(MessageSend.safeParse({ content: 'hi', clientMsgId: 'm1' }).success).toBe(true);
    // clientMsgId is still required — it is what de-duplicates a retry.
    expect(MessageSend.safeParse({ content: 'hi' }).success).toBe(false);
  });

  it('MessageNew validates a broadcast payload', () => {
    const parsed = MessageNew.safeParse({
      id: 'm1',
      conversationId: 'c1',
      senderType: 'agent',
      content: 'hello',
      createdAt: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.attachments).toEqual([]);
  });

  it('room helpers namespace correctly', () => {
    expect(rooms.conversation('1')).toBe('conversation:1');
    expect(rooms.agent('u')).toBe('agent:u');
    expect(rooms.vendor('v')).toBe('vendor:v');
  });

  it('event name constants are stable', () => {
    expect(SOCKET_EVENTS.messageSend).toBe('message:send');
    expect(SOCKET_EVENTS.messageNew).toBe('message:new');
    expect(SOCKET_EVENTS.typingUpdate).toBe('typing:update');
  });
});
