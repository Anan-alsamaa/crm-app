import { render, screen, fireEvent, act } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketCallbacks, WidgetMessage } from '../src/socket.js';
import { CUSTOMER_EDIT_WINDOW_MS, customerMessageActions } from '../src/socket.js';
import { Widget, type WidgetConfig } from '../src/Widget.js';

/**
 * THE CUSTOMER EDITS OR DELETES THEIR OWN MESSAGE (owner, 2026-10-07).
 *
 * "The customer must have this option from their end too ... like WhatsApp,
 * they can select a message and delete or modify it." Select (tap, or hold on
 * a phone) → pencil / trash icons → edit in the composer, or a short confirm
 * before deleting. Only their own, confirmed messages, only for 15 minutes.
 * The gateway enforces the rules; these cover what the widget offers and sends.
 */

if (!window.HTMLElement.prototype.scrollTo) {
  window.HTMLElement.prototype.scrollTo = () => {};
}

let lastCallbacks: SocketCallbacks | null = null;
const emitSpy = vi.fn();

vi.mock('../src/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/socket.js')>()),
  connectWidget: vi.fn((_url: string, _token: string, cb: SocketCallbacks) => {
    lastCallbacks = cb;
    cb.onStatus('connecting');
    return {
      emit: emitSpy,
      disconnect: vi.fn(),
      timeout: vi.fn(() => ({ emit: vi.fn() })),
    };
  }),
}));

const baseConfig: WidgetConfig = { gatewayUrl: 'https://gw.test', token: 'test-token' };

function drive(fn: () => void) {
  act(() => {
    fn();
  });
}

function ready() {
  drive(() => {
    lastCallbacks!.onStatus('connected');
    lastCallbacks!.onReady({
      conversationId: 'convo-1',
      branding: {},
      agentsOnline: 1,
      isNew: true,
    });
  });
}

function msg(over: Partial<WidgetMessage> = {}): WidgetMessage {
  return {
    id: 'srv-1',
    conversationId: 'convo-1',
    senderType: 'customer',
    content: 'my order is 1234',
    attachments: [],
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Render, connect, and put one message in the thread. */
function withMessage(m: WidgetMessage, config: Partial<WidgetConfig> = {}) {
  render(<Widget config={{ ...baseConfig, autoOpen: true, ...config }} />);
  ready();
  drive(() => lastCallbacks!.onMessage(m));
}

function bubble(text: string): HTMLElement {
  return screen.getByText(text).closest('.yiji-msg') as HTMLElement;
}

beforeEach(() => {
  lastCallbacks = null;
  emitSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('customerMessageActions — what may be offered', () => {
  const now = Date.parse('2026-10-07T10:00:00.000Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('own confirmed message inside 15 minutes: edit and delete', () => {
    expect(customerMessageActions(msg({ createdAt: at(60_000) }), now)).toEqual({
      edit: true,
      delete: true,
    });
  });

  it('closes after 15 minutes', () => {
    expect(CUSTOMER_EDIT_WINDOW_MS).toBe(15 * 60_000);
    expect(
      customerMessageActions(msg({ createdAt: at(CUSTOMER_EDIT_WINDOW_MS + 1) }), now),
    ).toEqual({
      edit: false,
      delete: false,
    });
  });

  it("never an agent's reply, a local notice or a deleted message", () => {
    const none = { edit: false, delete: false };
    expect(customerMessageActions(msg({ senderType: 'agent' }), now)).toEqual(none);
    expect(
      customerMessageActions(msg({ senderType: 'system', localNotice: 'send-failed' }), now),
    ).toEqual(none);
    expect(customerMessageActions(msg({ deletedAt: at(0), content: '' }), now)).toEqual(none);
  });

  it('never a message the gateway has not confirmed (no server id yet)', () => {
    const none = { edit: false, delete: false };
    expect(customerMessageActions(msg({ status: 'sending' }), now)).toEqual(none);
    expect(customerMessageActions(msg({ status: 'failed' }), now)).toEqual(none);
    expect(customerMessageActions(msg({ id: 'c1', clientMsgId: 'c1' }), now)).toEqual(none);
  });

  it('a photo with no words offers delete only', () => {
    expect(customerMessageActions(msg({ content: '', attachments: ['f1'] }), now)).toEqual({
      edit: false,
      delete: true,
    });
  });
});

describe('selecting an own message shows the icons', () => {
  it('a tap selects it and offers pencil + trash (icons, not words)', () => {
    withMessage(msg());
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    fireEvent.click(bubble('my order is 1234'));
    const edit = screen.getByRole('button', { name: 'Edit message' });
    const del = screen.getByRole('button', { name: 'Delete message' });
    expect(edit.querySelector('svg')).not.toBeNull();
    expect(edit.textContent).toBe('');
    expect(del.textContent).toBe('');
    expect(edit.getAttribute('title')).toBe('Edit message');
  });

  it('a long press selects it (touch, no hover in the app webview)', () => {
    vi.useFakeTimers();
    withMessage(msg());
    fireEvent.pointerDown(bubble('my order is 1234'), { clientX: 100 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerUp(bubble('my order is 1234'));
    // The click a mouse fires on release must not toggle it straight back off.
    fireEvent.click(bubble('my order is 1234'));
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeInTheDocument();
  });

  it("an agent's reply is not selectable for edit/delete", () => {
    withMessage(msg({ id: 'a1', senderType: 'agent', content: 'agent words' }));
    fireEvent.click(bubble('agent words'));
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it('no icons once the 15-minute window has passed', () => {
    withMessage(msg({ createdAt: new Date(Date.now() - 16 * 60_000).toISOString() }));
    fireEvent.click(bubble('my order is 1234'));
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it('a photo-only message offers delete but not edit', () => {
    withMessage(msg({ content: '', attachments: ['f1'] }));
    fireEvent.click(document.querySelector('.yiji-msg.mine') as HTMLElement);
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeInTheDocument();
  });

  it('Arabic labels the icons in Arabic', () => {
    withMessage(msg(), { locale: 'ar' });
    fireEvent.click(bubble('my order is 1234'));
    expect(screen.getByRole('button', { name: 'تعديل الرسالة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حذف الرسالة' })).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('puts the words in the composer and Save emits message:edit', () => {
    withMessage(msg());
    const box = screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: 'half-typed draft' } });
    fireEvent.click(bubble('my order is 1234'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));

    expect(box.value).toBe('my order is 1234');
    expect(screen.getByText('Editing message')).toBeInTheDocument();

    fireEvent.input(box, { target: { value: 'my order is 1235' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(emitSpy).toHaveBeenCalledWith('message:edit', {
      conversationId: 'convo-1',
      messageId: 'srv-1',
      content: 'my order is 1235',
    });
    // Not sent as a NEW message, and the parked draft comes back.
    expect(emitSpy).not.toHaveBeenCalledWith('message:send', expect.anything());
    expect(box.value).toBe('half-typed draft');
    expect(screen.queryByText('Editing message')).toBeNull();
  });

  it('cancel restores the draft and emits nothing', () => {
    withMessage(msg());
    fireEvent.click(bubble('my order is 1234'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    expect((screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement).value).toBe('');
    expect(emitSpy).not.toHaveBeenCalledWith('message:edit', expect.anything());
  });

  it('saving unchanged words emits nothing (no false "edited")', () => {
    withMessage(msg());
    fireEvent.click(bubble('my order is 1234'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.keyDown(screen.getByPlaceholderText('Type a message…'), { key: 'Enter' });
    expect(emitSpy).not.toHaveBeenCalledWith('message:edit', expect.anything());
  });

  it('the broadcast shows the new words with "edited"', () => {
    withMessage(msg());
    drive(() =>
      lastCallbacks!.onMessageEdited!({
        conversationId: 'convo-1',
        messageId: 'srv-1',
        content: 'my order is 1235',
        editedAt: new Date().toISOString(),
      }),
    );
    expect(screen.getByText('my order is 1235')).toBeInTheDocument();
    expect(screen.getByText('edited')).toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('asks first, then emits message:delete', () => {
    withMessage(msg());
    fireEvent.click(bubble('my order is 1234'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    expect(screen.getByText('Delete this message for everyone?')).toBeInTheDocument();
    expect(emitSpy).not.toHaveBeenCalledWith('message:delete', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(emitSpy).toHaveBeenCalledWith('message:delete', {
      conversationId: 'convo-1',
      messageId: 'srv-1',
    });
  });

  it('cancel at the confirm emits nothing', () => {
    withMessage(msg());
    fireEvent.click(bubble('my order is 1234'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(emitSpy).not.toHaveBeenCalledWith('message:delete', expect.anything());
  });

  it('the broadcast replaces the bubble with the placeholder, photo included', () => {
    withMessage(msg({ attachments: ['f1'] }));
    drive(() =>
      lastCallbacks!.onMessageDeleted!({
        conversationId: 'convo-1',
        messageId: 'srv-1',
        deletedAt: new Date().toISOString(),
      }),
    );
    expect(screen.queryByText('my order is 1234')).toBeNull();
    expect(screen.getByText('This message was deleted')).toBeInTheDocument();
    expect(document.querySelector('.yiji-msg-files')).toBeNull();
  });
});

describe('a refused edit', () => {
  it('says so in the customer’s language and does NOT fail an in-flight send', () => {
    withMessage(msg(), { locale: 'ar' });
    const box = screen.getByPlaceholderText('اكتب رسالة…');
    fireEvent.input(box, { target: { value: 'new one' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    drive(() =>
      lastCallbacks!.onServerError!({ code: 'edit_window_closed', message: 'english text' }),
    );
    expect(
      screen.getByText('يمكن تعديل الرسائل أو حذفها خلال ١٥ دقيقة فقط من إرسالها.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('english text')).toBeNull();
    expect(document.querySelector('.yiji-msg-failed')).toBeNull();
  });
});
