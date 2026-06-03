import { describe, it, expect } from 'vitest';
import { MessageSend, MessageNew, rooms, SOCKET_EVENTS } from '@yiji/shared-types';

describe('socket event contract (T039)', () => {
  it('MessageSend requires conversationId, content, clientMsgId', () => {
    expect(
      MessageSend.safeParse({ conversationId: 'c', content: 'hi', clientMsgId: 'm1' }).success,
    ).toBe(true);
    expect(MessageSend.safeParse({ conversationId: 'c', content: '' }).success).toBe(false);
    expect(MessageSend.safeParse({ content: 'hi', clientMsgId: 'm1' }).success).toBe(false);
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
