import { describe, it, expect } from 'vitest';
import {
  canEditMessage,
  MESSAGE_EDIT_WINDOW_MS,
  messageEditRefusal,
  originalContentPatch,
} from '../src/message-edit.js';
import { MessageDelete, MessageEdit, MessageNew, SOCKET_EVENTS } from '../src/socket.js';

/**
 * EDITING OR DELETING A SENT REPLY (owner, 2026-10-05 (EMA-33)).
 *
 * Only the sending agent, only their own non-note reply, only for 15 minutes.
 * The gateway enforces this; the portal reuses it to hide the buttons, so a
 * wrong answer here is either a tamper hole or buttons that always 403.
 */
const SENT = '2026-10-05T10:00:00.000Z';
const sentMs = Date.parse(SENT);
const own = {
  sender_type: 'agent',
  sender_user: 'agent-1',
  is_internal_note: false,
  date_created: SENT,
  deleted_at: null,
};

describe('messageEditRefusal', () => {
  it('allows the sending agent inside the window', () => {
    expect(messageEditRefusal(own, 'agent-1', sentMs + 60_000)).toBeNull();
    expect(canEditMessage(own, 'agent-1', sentMs + 60_000)).toBe(true);
  });

  it('the window is 15 minutes from SENDING', () => {
    expect(MESSAGE_EDIT_WINDOW_MS).toBe(15 * 60_000);
    expect(messageEditRefusal(own, 'agent-1', sentMs + MESSAGE_EDIT_WINDOW_MS)).toBeNull();
    expect(messageEditRefusal(own, 'agent-1', sentMs + MESSAGE_EDIT_WINDOW_MS + 1)).toBe(
      'edit_window_closed',
    );
  });

  it("refuses a colleague's reply", () => {
    expect(messageEditRefusal(own, 'agent-2', sentMs)).toBe('not_own_message');
  });

  it('accepts an expanded sender_user object', () => {
    expect(messageEditRefusal({ ...own, sender_user: { id: 'agent-1' } }, 'agent-1', sentMs)).toBe(
      null,
    );
  });

  it('refuses customer and system messages', () => {
    expect(messageEditRefusal({ ...own, sender_type: 'customer' }, 'agent-1', sentMs)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal({ ...own, sender_type: 'system' }, 'agent-1', sentMs)).toBe(
      'not_own_message',
    );
  });

  it('refuses internal notes — they have their own delete', () => {
    expect(messageEditRefusal({ ...own, is_internal_note: true }, 'agent-1', sentMs)).toBe(
      'not_own_message',
    );
  });

  it('refuses an already deleted message', () => {
    expect(messageEditRefusal({ ...own, deleted_at: SENT }, 'agent-1', sentMs)).toBe(
      'already_deleted',
    );
  });

  it('fails CLOSED on a missing row, agent or timestamp', () => {
    expect(messageEditRefusal(null, 'agent-1', sentMs)).toBe('not_found');
    expect(messageEditRefusal(own, null, sentMs)).toBe('not_own_message');
    expect(messageEditRefusal({ ...own, date_created: null }, 'agent-1', sentMs)).toBe(
      'edit_window_closed',
    );
  });
});

/*
 * THE CUSTOMER MAY CHANGE THEIR OWN WORDS TOO (owner, 2026-10-07): only a
 * message they sent, only in the conversation their widget is bound to, under
 * the same 15-minute window — never an agent's reply or another customer's.
 */
describe('messageEditRefusal — customer', () => {
  const mine = {
    sender_type: 'customer',
    sender_user: null,
    sender_contact: 'contact-1',
    conversation: 'conv-1',
    is_internal_note: false,
    date_created: SENT,
    deleted_at: null,
  };
  const me = { kind: 'customer' as const, contactId: 'contact-1', conversationId: 'conv-1' };

  it('allows their own message in their own conversation inside the window', () => {
    expect(messageEditRefusal(mine, me, sentMs + 60_000)).toBeNull();
    expect(canEditMessage(mine, me, sentMs + 60_000)).toBe(true);
  });

  it('accepts expanded relation objects', () => {
    expect(
      messageEditRefusal(
        { ...mine, sender_contact: { id: 'contact-1' }, conversation: { id: 'conv-1' } },
        me,
        sentMs,
      ),
    ).toBeNull();
  });

  it("refuses another customer's message", () => {
    expect(messageEditRefusal({ ...mine, sender_contact: 'contact-2' }, me, sentMs)).toBe(
      'not_own_message',
    );
  });

  it("refuses a message in another conversation, even the same contact's older thread", () => {
    expect(messageEditRefusal({ ...mine, conversation: 'conv-old' }, me, sentMs)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal(mine, { ...me, conversationId: null }, sentMs)).toBe(
      'not_own_message',
    );
  });

  it("refuses an agent's reply, a system line and the automatic welcome", () => {
    expect(
      messageEditRefusal({ ...mine, sender_type: 'agent', sender_user: 'agent-1' }, me, sentMs),
    ).toBe('not_own_message');
    expect(messageEditRefusal({ ...mine, sender_type: 'system' }, me, sentMs)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal({ ...mine, sender_type: 'agent' }, me, sentMs)).toBe(
      'not_own_message',
    );
  });

  it('the same 15-minute window', () => {
    expect(messageEditRefusal(mine, me, sentMs + MESSAGE_EDIT_WINDOW_MS)).toBeNull();
    expect(messageEditRefusal(mine, me, sentMs + MESSAGE_EDIT_WINDOW_MS + 1)).toBe(
      'edit_window_closed',
    );
  });

  it('refuses an already deleted message', () => {
    expect(messageEditRefusal({ ...mine, deleted_at: SENT }, me, sentMs)).toBe('already_deleted');
  });

  it('fails CLOSED on a row with no contact or conversation, or a missing contact id', () => {
    expect(messageEditRefusal({ ...mine, sender_contact: null }, me, sentMs)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal({ ...mine, conversation: undefined }, me, sentMs)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal(mine, { ...me, contactId: undefined }, sentMs)).toBe(
      'not_own_message',
    );
  });

  it("an AGENT still cannot touch the customer's message", () => {
    expect(messageEditRefusal(mine, 'agent-1', sentMs)).toBe('not_own_message');
    expect(messageEditRefusal(mine, { kind: 'agent', agentId: 'agent-1' }, sentMs)).toBe(
      'not_own_message',
    );
  });

  it('the object form of an agent behaves exactly like the bare id', () => {
    expect(messageEditRefusal(own, { kind: 'agent', agentId: 'agent-1' }, sentMs)).toBeNull();
    expect(messageEditRefusal(own, { kind: 'agent', agentId: 'agent-2' }, sentMs)).toBe(
      'not_own_message',
    );
  });
});

describe('originalContentPatch', () => {
  it('records the wording on the FIRST edit', () => {
    expect(originalContentPatch({ content: 'hello', original_content: null })).toBe('hello');
  });

  it('never overwrites it on a later edit or delete', () => {
    expect(originalContentPatch({ content: 'v2', original_content: 'v1' })).toBeUndefined();
  });
});

describe('socket contracts', () => {
  it('names the four events', () => {
    expect(SOCKET_EVENTS.messageEdit).toBe('message:edit');
    expect(SOCKET_EVENTS.messageDelete).toBe('message:delete');
    expect(SOCKET_EVENTS.messageEdited).toBe('message:edited');
    expect(SOCKET_EVENTS.messageDeleted).toBe('message:deleted');
  });

  it('an edit must carry trimmed, non-empty text', () => {
    expect(
      MessageEdit.safeParse({ conversationId: 'c', messageId: 'm', content: '   ' }).success,
    ).toBe(false);
    const ok = MessageEdit.parse({ conversationId: 'c', messageId: 1, content: '  hi  ' });
    expect(ok).toEqual({ conversationId: 'c', messageId: '1', content: 'hi' });
  });

  it('a delete needs both ids', () => {
    expect(MessageDelete.safeParse({ conversationId: 'c' }).success).toBe(false);
  });

  it('message:new may carry the sending agent id', () => {
    const m = MessageNew.parse({
      id: 'm',
      conversationId: 'c',
      senderType: 'agent',
      content: 'x',
      createdAt: SENT,
      senderUserId: 'agent-1',
    });
    expect(m.senderUserId).toBe('agent-1');
  });
});
