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
  MessageActions,
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

  /* The customer may change their own words too (owner, 2026-10-07): the same
     broadcast lands here, and must render the same way. */
  it("applies the CUSTOMER's own edit and delete the same way", () => {
    const theirs = msg({
      id: 'c1',
      sender_type: 'customer',
      sender_user: null,
      content: 'order 1234',
    });
    const [edited] = applyMessageEdited([theirs], {
      messageId: 'c1',
      content: 'order 1235',
      editedAt: 'T1',
    });
    expect(edited).toMatchObject({ content: 'order 1235', edited_at: 'T1' });
    const [deleted] = applyMessageDeleted([theirs], { messageId: 'c1', deletedAt: 'T2' });
    expect(deleted).toMatchObject({ content: '', attachments: [], deleted_at: 'T2' });
    // ...and an agent is never offered Edit/Delete on the customer's words.
    expect(canOfferMessageActions(theirs, 'agent-1', sentMs)).toBe(false);
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

/*
 * ICONS, NOT WORDS — SELECT, THEN ACT (owner, 2026-10-07): "instead of 2
 * buttons let there be icons — like WhatsApp".
 */
describe('MessageActions', () => {
  it('offers copy, edit and delete as named ICONS with no visible words', () => {
    const onCopy = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<MessageActions selected onCopy={onCopy} onEdit={onEdit} onDelete={onDelete} />);
    for (const name of ['Copy message', 'Edit message', 'Delete message']) {
      const btn = screen.getByRole('button', { name });
      expect(btn.textContent).toBe('');
      expect(btn.querySelector('svg')).not.toBeNull();
      expect(btn.getAttribute('title')).toBe(name);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    expect(onCopy).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });

  it("someone else's message (or a closed window) offers Copy only", () => {
    render(<MessageActions selected={false} onCopy={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it('an attachment-only reply offers Delete only', () => {
    render(<MessageActions selected={false} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeTruthy();
  });

  it('stays visible while SELECTED, hover-only otherwise', () => {
    const { rerender } = render(<MessageActions selected={false} onCopy={vi.fn()} />);
    const bar = screen.getByRole('toolbar', { name: 'Message actions' });
    expect(bar.className).toContain('opacity-0');
    rerender(<MessageActions selected onCopy={vi.fn()} />);
    expect(screen.getByRole('toolbar', { name: 'Message actions' }).className).toContain(
      'opacity-100',
    );
  });

  it('renders nothing with no actions', () => {
    const { container } = render(<MessageActions selected />);
    expect(container.innerHTML).toBe('');
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

  it('a click SELECTS a message and pins its icon bar; edit/delete stay gated', () => {
    expect(VIEW).toContain('toggleSelected(m.id)');
    expect(VIEW).toContain('selected={selectedId === m.id}');
    expect(VIEW).toContain("can('edit_own_messages')");
    expect(VIEW).toMatch(/onEdit=\{\s*ownActions/);
    expect(VIEW).toMatch(/onDelete=\{\s*ownActions/);
    expect(VIEW).not.toContain('OwnMessageActions');
  });

  it('shows the edited label and the deleted placeholder, and confirms a delete', () => {
    expect(VIEW).toContain("t('conversation.messageEdited'");
    expect(VIEW).toContain("t('conversation.messageDeleted'");
    expect(VIEW).toContain('<ConfirmDialog');
    expect(VIEW).toContain('SOCKET_EVENTS.messageDelete');
    expect(VIEW).toContain('SOCKET_EVENTS.messageEdit,');
  });
});
