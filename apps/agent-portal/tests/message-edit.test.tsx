import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import {
  InlineMessageEditor,
  OwnMessageActions,
} from '../src/features/conversation/MessageEditControls.js';
import {
  applyMessageDeleted,
  applyMessageEdited,
  canOfferMessageActions,
} from '../src/features/conversation/message-edits.js';
import type { ConversationMessage } from '../src/features/inbox/api.js';

/**
 * EDIT OR DELETE A SENT REPLY (owner, 2026-10-05 (EMA-33)).
 *
 * The agent sees Edit/Delete on their OWN reply for 15 minutes; the thread
 * shows "edited" on a corrected reply and a placeholder for a withdrawn one.
 * The gateway enforces the rules; these cover what the portal shows.
 */
afterEach(() => cleanup());

const SENT = '2026-10-05T10:00:00.000Z';
const sentMs = Date.parse(SENT);
const msg = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  sender_type: 'agent',
  sender_user: 'agent-1',
  content: 'Your refund is 50 SAR',
  is_internal_note: false,
  date_created: SENT,
  attachments: [{ id: 'f1', filename: 'a.png', type: 'image/png', filesize: 1 }],
  ...over,
});

describe('which messages offer Edit/Delete', () => {
  it('the own reply inside 15 minutes', () => {
    expect(canOfferMessageActions(msg(), 'agent-1', sentMs + 14 * 60_000)).toBe(true);
  });
  it('not after the window', () => {
    expect(canOfferMessageActions(msg(), 'agent-1', sentMs + 16 * 60_000)).toBe(false);
  });
  it("not a colleague's reply, a customer message or an internal note", () => {
    expect(canOfferMessageActions(msg(), 'agent-2', sentMs)).toBe(false);
    expect(canOfferMessageActions(msg({ sender_type: 'customer' }), 'agent-1', sentMs)).toBe(false);
    expect(canOfferMessageActions(msg({ is_internal_note: true }), 'agent-1', sentMs)).toBe(false);
  });
  it('not an optimistic message still waiting for its id', () => {
    expect(canOfferMessageActions(msg({ pending: true }), 'agent-1', sentMs)).toBe(false);
  });
  it('not a deleted one', () => {
    expect(canOfferMessageActions(msg({ deleted_at: SENT }), 'agent-1', sentMs)).toBe(false);
  });
});

describe('applying live edits to the thread', () => {
  it('an edit replaces the wording and stamps edited_at', () => {
    const [m] = applyMessageEdited([msg()], {
      messageId: 'm1',
      content: 'Your refund is 60 SAR',
      editedAt: 'T1',
    });
    expect(m).toMatchObject({ content: 'Your refund is 60 SAR', edited_at: 'T1' });
  });

  it('a delete blanks content AND attachments', () => {
    const [m] = applyMessageDeleted([msg()], { messageId: 'm1', deletedAt: 'T2' });
    expect(m).toMatchObject({ content: '', attachments: [], deleted_at: 'T2' });
  });

  it('an edit cannot resurrect a deleted message', () => {
    const list = [msg({ content: '', deleted_at: 'T2' })];
    const out = applyMessageEdited(list, { messageId: 'm1', content: 'back', editedAt: 'T3' });
    expect(out[0]!.content).toBe('');
  });

  it('returns the SAME list when the message is not in it (no needless re-render)', () => {
    const list = [msg()];
    expect(applyMessageEdited(list, { messageId: 'x', content: 'y', editedAt: 'T' })).toBe(list);
    expect(applyMessageDeleted(list, { messageId: 'x', deletedAt: 'T' })).toBe(list);
  });
});

describe('InlineMessageEditor', () => {
  it('Enter saves the trimmed text', () => {
    const onSave = vi.fn();
    render(<InlineMessageEditor initial="hello" onSave={onSave} onCancel={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '  hello there ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledWith('hello there');
  });

  it('Esc cancels', () => {
    const onCancel = vi.fn();
    render(<InlineMessageEditor initial="hello" onSave={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('cannot save an empty or unchanged message', () => {
    const onSave = vi.fn();
    render(<InlineMessageEditor initial="hello" onSave={onSave} onCancel={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  it('Save and Cancel buttons work', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<InlineMessageEditor initial="a" onSave={onSave} onCancel={onCancel} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).toHaveBeenCalledWith('b');
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('OwnMessageActions', () => {
  it('offers Edit and Delete', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<OwnMessageActions canEdit onEdit={onEdit} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });

  it('an attachment-only reply offers Delete only', () => {
    render(<OwnMessageActions canEdit={false} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeTruthy();
  });
});

/*
 * Wiring in ConversationView, asserted against the SOURCE like the other view
 * tests: mounting it needs a conversation, socket, QueryClient and auth context,
 * and what matters is that the listeners are attached AND detached (see the
 * listener-leak test) and both lists are patched.
 */
const VIEW = readFileSync(
  resolve(process.cwd(), 'src/features/conversation/ConversationView.tsx'),
  'utf8',
);

describe('ConversationView wiring', () => {
  it('listens for edits and deletes, and detaches both', () => {
    for (const ev of ['messageEdited', 'messageDeleted']) {
      expect(VIEW).toContain(`socket.on(SOCKET_EVENTS.${ev},`);
      expect(VIEW).toContain(`socket.off(SOCKET_EVENTS.${ev},`);
    }
  });

  it('patches the query cache as well as the live buffer', () => {
    expect(VIEW).toMatch(
      /setQueryData<ConversationMessage\[\]>\(\['messages', conversationId\][\s\S]{0,80}applyMessageEdited/,
    );
    expect(VIEW).toMatch(
      /setQueryData<ConversationMessage\[\]>\(\['messages', conversationId\][\s\S]{0,80}applyMessageDeleted/,
    );
  });

  it('maps senderUserId so own live replies are editable', () => {
    // Null only for the automatic welcome (owner, 2026-10-06); see auto-welcome-rendering.
    expect(VIEW).toMatch(/sender_user:\s*msg\.senderUserId \?\?/);
  });

  it('shows the edited label and the deleted placeholder, and confirms a delete', () => {
    expect(VIEW).toContain("t('conversation.messageEdited'");
    expect(VIEW).toContain("t('conversation.messageDeleted'");
    expect(VIEW).toContain('<ConfirmDialog');
    expect(VIEW).toContain('SOCKET_EVENTS.messageDelete');
    expect(VIEW).toContain('SOCKET_EVENTS.messageEdit,');
  });
});
