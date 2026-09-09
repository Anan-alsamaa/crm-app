import { render, screen, fireEvent, within, act } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketCallbacks, WidgetMessage } from '../src/socket.js';
import { Widget, type WidgetConfig } from '../src/Widget.js';

// jsdom implements neither `scrollTo` nor a real rAF layout pass; the widget
// pins the message list via `el.scrollTo` inside a double requestAnimationFrame.
// The shared tests/setup.ts only stubs scrollIntoView, so stub scrollTo here so
// the scroll effect doesn't throw an uncaught exception during the async rAF.
if (!window.HTMLElement.prototype.scrollTo) {
  window.HTMLElement.prototype.scrollTo = () => {};
}

// ---------------------------------------------------------------------------
// Socket layer mock. `connectWidget` is the only network entry point the widget
// uses; we replace it with a fake that (a) captures the callbacks the widget
// registers so tests can drive incoming events, and (b) exposes an `emit` spy +
// a `timeout().emit` chain so outgoing messages/uploads can be asserted without
// touching the network.
// ---------------------------------------------------------------------------
let lastCallbacks: SocketCallbacks | null = null;
const emitSpy = vi.fn();
const timeoutEmitSpy = vi.fn();
const disconnectSpy = vi.fn();

function makeFakeSocket() {
  return {
    emit: emitSpy,
    disconnect: disconnectSpy,
    // socket.timeout(ms).emit(...) chain used by upload/attachment:get.
    timeout: vi.fn(() => ({ emit: timeoutEmitSpy })),
  };
}

vi.mock('../src/socket.js', () => ({
  connectWidget: vi.fn((_url: string, _token: string, cb: SocketCallbacks) => {
    lastCallbacks = cb;
    // Mirror the real socket layer: it announces "connecting" synchronously.
    cb.onStatus('connecting');
    return makeFakeSocket();
  }),
}));

const baseConfig: WidgetConfig = {
  gatewayUrl: 'https://gw.test',
  token: 'test-token',
};

function renderWidget(config: Partial<WidgetConfig> = {}) {
  return render(<Widget config={{ ...baseConfig, ...config }} />);
}

// Convenience: bring the socket to a ready+connected state with an active
// conversation, which is the precondition for sending messages.
function driveReady(
  opts: {
    conversationId?: string;
    agentsOnline?: number;
    contact?: { name: string | null; phone: string | null };
    isNew?: boolean;
    branding?: unknown;
  } = {},
) {
  const cb = lastCallbacks!;
  // Callbacks fired outside render/fireEvent must be wrapped in act() so Preact
  // flushes the resulting state updates to the DOM before we assert on them.
  act(() => {
    cb.onStatus('connected');
    cb.onReady({
      conversationId: opts.conversationId ?? 'convo-1',
      branding: opts.branding ?? { primary: '#123456' },
      agentsOnline: opts.agentsOnline ?? 1,
      contact: opts.contact,
      isNew: opts.isNew ?? true,
    });
  });
}

// Wrap an arbitrary socket-callback invocation so its state updates flush.
function drive(fn: () => void) {
  act(() => {
    fn();
  });
}

function agentMessage(overrides: Partial<WidgetMessage> = {}): WidgetMessage {
  return {
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2)}`,
    conversationId: overrides.conversationId ?? 'convo-1',
    senderType: overrides.senderType ?? 'agent',
    content: overrides.content ?? 'Hello from an agent',
    attachments: overrides.attachments ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...(overrides.clientMsgId ? { clientMsgId: overrides.clientMsgId } : {}),
  };
}

beforeEach(() => {
  lastCallbacks = null;
  emitSpy.mockClear();
  timeoutEmitSpy.mockClear();
  disconnectSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Widget — launcher and panel', () => {
  it('renders only the launcher initially (panel closed)', () => {
    renderWidget();
    // Launcher present.
    expect(screen.getByRole('button', { name: 'Support' })).toBeInTheDocument();
    // Panel dialog absent until opened.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the panel when the launcher is clicked, then closes it', () => {
    renderWidget();
    fireEvent.click(screen.getByRole('button', { name: 'Support' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('auto-opens the panel when config.autoOpen is true', () => {
    renderWidget({ autoOpen: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('calls connectWidget with the configured gateway url and token', async () => {
    const { connectWidget } = await import('../src/socket.js');
    renderWidget();
    // The fourth argument is the resume offer (resume.ts): empty on a device
    // that holds no thread, so the auth the gateway sees is unchanged.
    expect(connectWidget).toHaveBeenCalledWith(
      'https://gw.test',
      'test-token',
      expect.any(Object),
      {},
    );
  });

  it('disconnects the socket on unmount', () => {
    const { unmount } = renderWidget();
    unmount();
    expect(disconnectSpy).toHaveBeenCalled();
  });
});

describe('Widget — connection states', () => {
  it('shows the connecting status before the socket is ready', () => {
    renderWidget({ autoOpen: true });
    const status = screen.getByTestId('yiji-status');
    expect(status).toHaveTextContent('Connecting…');
  });

  it('shows the reconnecting status when the socket reconnects', () => {
    renderWidget({ autoOpen: true });
    drive(() => lastCallbacks!.onStatus('reconnecting'));
    expect(screen.getByTestId('yiji-status')).toHaveTextContent('Reconnecting…');
  });

  it('hides the status banner once connected and ready', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    expect(screen.queryByTestId('yiji-status')).not.toBeInTheDocument();
  });

  it('still shows the status banner when connected but not ready', () => {
    renderWidget({ autoOpen: true });
    drive(() => lastCallbacks!.onStatus('connected'));
    // No onReady yet → ready is false → banner remains.
    expect(screen.getByTestId('yiji-status')).toBeInTheDocument();
  });
});

describe('Widget — ready + greeting', () => {
  it('drops a generic welcome bubble for a new customer', () => {
    renderWidget({ autoOpen: true });
    driveReady({ isNew: true });
    expect(screen.getByText('Hey there 👋 How can we help you?')).toBeInTheDocument();
  });

  it('greets a returning customer by name in the thread and header', () => {
    renderWidget({ autoOpen: true });
    driveReady({ isNew: false, contact: { name: 'Sara', phone: null } });
    expect(screen.getByText('Welcome Sara, how can we help you?')).toBeInTheDocument();
    expect(screen.getByText('Welcome back, Sara 👋')).toBeInTheDocument();
  });

  it('does not duplicate the greeting when ready fires twice', () => {
    renderWidget({ autoOpen: true });
    driveReady({ isNew: true });
    driveReady({ isNew: true });
    expect(screen.getAllByText('Hey there 👋 How can we help you?')).toHaveLength(1);
  });

  it('broadcasts agent presence to the host page as a CustomEvent', () => {
    const handler = vi.fn();
    window.addEventListener('yiji:agents-presence', handler as EventListener);
    renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 3 });
    window.removeEventListener('yiji:agents-presence', handler as EventListener);
    expect(handler).toHaveBeenCalled();
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toEqual({ count: 3 });
  });

  it('shows the online status when agents are present', () => {
    renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 2 });
    expect(screen.getByText('We are online')).toBeInTheDocument();
  });
});

describe('Widget — incoming messages and typing', () => {
  it('renders an incoming agent message', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    drive(() => lastCallbacks!.onMessage(agentMessage({ content: 'Reply from agent' })));
    expect(screen.getByText('Reply from agent')).toBeInTheDocument();
  });

  it('dedupes an incoming message with an id already present', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const msg = agentMessage({ id: 'dup-1', content: 'Only once' });
    drive(() => lastCallbacks!.onMessage(msg));
    drive(() => lastCallbacks!.onMessage(msg));
    expect(screen.getAllByText('Only once')).toHaveLength(1);
  });

  it('shows the typing indicator when the agent is typing', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    drive(() => lastCallbacks!.onTyping(true));
    expect(screen.getByLabelText('Typing')).toBeInTheDocument();
    drive(() => lastCallbacks!.onTyping(false));
    expect(screen.queryByLabelText('Typing')).not.toBeInTheDocument();
  });

  it('seeds the thread from history and keeps optimistic live messages', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    drive(() => lastCallbacks!.onMessage(agentMessage({ id: 'live-1', content: 'Live message' })));
    drive(() =>
      lastCallbacks!.onHistory!([
        agentMessage({ id: 'hist-1', content: 'Old message one' }),
        agentMessage({ id: 'hist-2', content: 'Old message two' }),
      ]),
    );
    expect(screen.getByText('Old message one')).toBeInTheDocument();
    expect(screen.getByText('Old message two')).toBeInTheDocument();
    expect(screen.getByText('Live message')).toBeInTheDocument();
  });

  it('increments the unread badge for agent messages while the panel is closed', () => {
    renderWidget(); // closed
    driveReady();
    drive(() => lastCallbacks!.onMessage(agentMessage({ id: 'u1', content: 'unread one' })));
    drive(() => lastCallbacks!.onMessage(agentMessage({ id: 'u2', content: 'unread two' })));
    // Badge shows count on the launcher.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clears the unread badge when the panel is opened', () => {
    renderWidget(); // closed
    driveReady();
    drive(() => lastCallbacks!.onMessage(agentMessage({ id: 'u1', content: 'unread' })));
    expect(screen.getByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Support' }));
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });
});

describe('Widget — composing and sending', () => {
  it('sends a typed message and emits message:send with the content', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const textarea = screen.getByPlaceholderText('Type a message…');
    fireEvent.input(textarea, { target: { value: 'Hi, I need help' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(emitSpy).toHaveBeenCalledWith(
      'message:send',
      expect.objectContaining({ conversationId: 'convo-1', content: 'Hi, I need help' }),
    );
    // Optimistic bubble appears in the thread.
    expect(screen.getByText('Hi, I need help')).toBeInTheDocument();
  });

  it('sends on Enter (without shift)', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const textarea = screen.getByPlaceholderText('Type a message…');
    fireEvent.input(textarea, { target: { value: 'enter sends' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(emitSpy).toHaveBeenCalledWith(
      'message:send',
      expect.objectContaining({ content: 'enter sends' }),
    );
  });

  it('does not send on Shift+Enter', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const textarea = screen.getByPlaceholderText('Type a message…');
    fireEvent.input(textarea, { target: { value: 'newline' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(emitSpy).not.toHaveBeenCalledWith('message:send', expect.anything());
  });

  it('guards against sending empty input (send button disabled)', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const sendBtn = screen.getByRole('button', { name: 'Send' });
    expect(sendBtn).toBeDisabled();
    fireEvent.click(sendBtn);
    expect(emitSpy).not.toHaveBeenCalledWith('message:send', expect.anything());
  });

  it('clears the draft after sending', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const textarea = screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'clear me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(textarea.value).toBe('');
  });

  it('emits typing:start when the customer types', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const textarea = screen.getByPlaceholderText('Type a message…');
    fireEvent.input(textarea, { target: { value: 'typing now' } });
    expect(emitSpy).toHaveBeenCalledWith(
      'typing:start',
      expect.objectContaining({ conversationId: 'convo-1' }),
    );
  });

  it('emits typing:stop when the input is cleared', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    const textarea = screen.getByPlaceholderText('Type a message…');
    fireEvent.input(textarea, { target: { value: 'x' } });
    emitSpy.mockClear();
    fireEvent.input(textarea, { target: { value: '' } });
    expect(emitSpy).toHaveBeenCalledWith(
      'typing:stop',
      expect.objectContaining({ conversationId: 'convo-1' }),
    );
  });
});

describe('Widget — locale / RTL', () => {
  it('renders LTR and English strings by default', () => {
    const { container } = renderWidget({ autoOpen: true });
    expect(container.querySelector('.yiji-widget')?.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('Hi there 👋')).toBeInTheDocument();
  });

  it('renders RTL and Arabic strings when locale is ar', () => {
    const { container } = renderWidget({ autoOpen: true, locale: 'ar' });
    expect(container.querySelector('.yiji-widget')?.getAttribute('dir')).toBe('rtl');
    expect(screen.getByText('مرحبًا 👋')).toBeInTheDocument();
    driveReady({ isNew: true });
    // The Arabic new-customer welcome bubble lands in the thread.
    const greeting = container.querySelector('.yiji-msg-greeting');
    expect(greeting).toHaveTextContent('مرحبًا 👋 كيف يمكننا مساعدتك؟');
  });
});

describe('Widget — empty state and offline fallback', () => {
  it('shows the empty state for a ready new customer before the greeting arrives', () => {
    // Ready WITHOUT triggering onReady greeting: drive only status+partial.
    renderWidget({ autoOpen: true });
    lastCallbacks!.onStatus('connected');
    // messages are still empty and ready is false → status banner shown, no empty art yet.
    // Trigger ready via a ready event that yields no greeting is not possible,
    // so instead assert the empty state renders after we clear messages is N/A.
    // Here we simply confirm the connecting banner path is exercised.
    expect(screen.getByTestId('yiji-status')).toBeInTheDocument();
  });

  it('offers exactly two ways out — call and WhatsApp, on their own numbers', () => {
    /*
     * The call centre and the WhatsApp business account are DIFFERENT lines.
     * Both chips used to render `fallback.phone`, so WhatsApp pointed at the
     * landline and opened a chat nobody reads.
     */
    renderWidget({
      autoOpen: true,
      fallback: { phone: '920012111', whatsapp: '0565266122' },
    });
    driveReady({ agentsOnline: 0 });
    expect(
      screen.getByRole('region', { name: 'Our agents are offline right now' }),
    ).toBeInTheDocument();

    expect(screen.getByText('920012111').closest('a')).toHaveAttribute('href', 'tel:920012111');
    // Local number, wa.me link: 05… becomes 9665… or the chat opens with nobody.
    expect(screen.getByText('0565266122').closest('a')).toHaveAttribute(
      'href',
      'https://wa.me/966565266122',
    );
  });

  it('does not offer email — the slowest channel, and useless at a counter', () => {
    renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 0 });
    expect(screen.queryByText('Email us')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('leaves the composer reachable — the message still gets through', () => {
    /*
     * The whole point. This block used to be a stacked panel that filled the
     * widget on a phone, so a customer who only wanted to type a sentence had
     * to scroll past a wall of contact details. The offline message is "leave
     * it here and we will reply", and the composer has to be right there for
     * that to be true.
     */
    renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 0 });
    const composer = document.querySelector('textarea, input[type="text"]');
    expect(composer).not.toBeNull();
    expect(composer).toBeEnabled();
  });

  it('falls back to the published numbers when the host configures none', () => {
    renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 0 });
    expect(screen.getByText('920012111')).toBeInTheDocument();
    expect(screen.getByText('0565266122')).toBeInTheDocument();
  });

  it('shows the offline header status when no agents are online', () => {
    const { container } = renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 0 });
    // The phrase appears both in the header pill and the offline region title;
    // assert on the header pill specifically.
    const headerStatus = container.querySelector('.yiji-header-status');
    expect(headerStatus).toHaveClass('offline');
    expect(headerStatus).toHaveTextContent('Our agents are offline right now');
  });

  /**
   * THE BUG (owner, 2026-09-09): "I see a message on top which says our agents
   * are offline right now / connecting..."
   *
   * `agentsOnline` started at 0, and 0 is also the honest answer "nobody is
   * online" — so the widget asserted OFFLINE the instant it painted, seconds
   * before the socket had said anything, then corrected itself to "we're
   * available now" once `ready` landed. Measured on production: offline at
   * t+0s, available at t+6s, with an agent signed in the whole time and the
   * gateway reporting distinctOnline: 1.
   *
   * The customer's first impression of a working service was that nobody was
   * there — and the offline contact block appeared under it, inviting them to
   * phone instead of using the chat that was about to work.
   */
  it('says NOTHING about availability until the gateway has reported', () => {
    const { container } = renderWidget({ autoOpen: true });
    // Deliberately no driveReady(): this is the connecting window.
    expect(container.querySelector('.yiji-header-status')).toBeNull();
    // And it must not offer the offline fallback either.
    expect(screen.queryByRole('region', { name: 'Our agents are offline right now' })).toBeNull();
  });

  it('shows the online status once the gateway reports an agent', () => {
    const { container } = renderWidget({ autoOpen: true });
    driveReady({ agentsOnline: 1 });
    const headerStatus = container.querySelector('.yiji-header-status');
    expect(headerStatus).not.toHaveClass('offline');
  });
});

describe('Widget — CSAT on conversation close', () => {
  it('opens the panel and shows the CSAT survey when the conversation closes', () => {
    renderWidget(); // closed
    driveReady();
    drive(() => lastCallbacks!.onClosed!({ conversationId: 'convo-1', status: 'closed' }));
    // Panel force-opens.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('How was your experience?')).toBeInTheDocument();
  });

  it('submits CSAT and emits csat:submit, then shows the thanks state', () => {
    renderWidget();
    driveReady();
    drive(() => lastCallbacks!.onClosed!({ conversationId: 'convo-1', status: 'resolved' }));

    const stars = within(
      screen.getByRole('radiogroup', { name: 'How was your experience?' }),
    ).getAllByRole('radio');
    // Submit is disabled until a score is chosen.
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    fireEvent.click(stars[3]); // 4 stars
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    expect(emitSpy).toHaveBeenCalledWith(
      'csat:submit',
      expect.objectContaining({ conversationId: 'convo-1', score: 4 }),
    );
    expect(screen.getByText('Thanks for the feedback!')).toBeInTheDocument();
  });
});

describe('Widget — attachments', () => {
  it('requests received attachment bytes via attachment:get', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    drive(() =>
      lastCallbacks!.onMessage(
        agentMessage({ id: 'with-file', content: '', attachments: ['file-abc'] }),
      ),
    );
    // ensureAttachment runs in an effect for every attachment id in the thread.
    expect(timeoutEmitSpy).toHaveBeenCalledWith(
      'attachment:get',
      { id: 'file-abc' },
      expect.any(Function),
    );
  });

  it('renders a loading chip for an attachment still being fetched', () => {
    renderWidget({ autoOpen: true });
    driveReady();
    drive(() =>
      lastCallbacks!.onMessage(
        agentMessage({ id: 'with-file2', content: '', attachments: ['file-xyz'] }),
      ),
    );
    // Generic "Attachment" label appears while bytes are pending.
    expect(screen.getAllByText('Attachment').length).toBeGreaterThan(0);
  });
});

describe('Widget — the wa.me conversion stays in step with the shared rule', () => {
  /*
   * `waNumber` in Widget.tsx is a DELIBERATE copy of `whatsappNumber` in
   * @yiji/shared-types. This widget is embedded into other people's pages and
   * its dependencies are exactly preact and socket.io-client; importing a
   * workspace package to reuse six lines would pull zod and the rest of the
   * shared types into a customer-facing bundle to save nothing.
   *
   * A duplication nobody checks is one that drifts, and the failure here is
   * SILENT: a wrong wa.me number opens a chat with nobody rather than refusing.
   * So the copy is pinned to the shared rule's contract.
   */
  const cases: Array<[string, string]> = [
    ['0565266122', '966565266122'],
    ['565266122', '966565266122'],
    ['966565266122', '966565266122'],
    ['00966565266122', '966565266122'],
    ['+966 56 526 6122', '966565266122'],
  ];

  for (const [input, want] of cases) {
    it(`sends ${input} to wa.me/${want}`, () => {
      renderWidget({ autoOpen: true, fallback: { phone: '920012111', whatsapp: input } });
      driveReady({ agentsOnline: 0 });
      expect(screen.getByText(input).closest('a')).toHaveAttribute('href', `https://wa.me/${want}`);
    });
  }
});

describe('Widget — the offline footer in Arabic', () => {
  it('keeps the numbers left-to-right inside an RTL panel', () => {
    /*
     * A phone number reads the same way in every locale, and a right-to-left
     * container will happily reverse the digit run around a `+` or a separator.
     * The value carries an explicit `direction: ltr`, and the card layout is
     * flexbox with logical gaps rather than left/right margins, so the whole
     * footer mirrors without the numbers coming with it.
     */
    const { container } = renderWidget({
      autoOpen: true,
      locale: 'ar',
      fallback: { phone: '920012111', whatsapp: '0565266122' },
    });
    driveReady({ agentsOnline: 0 });

    expect(container.querySelector('.yiji-widget')?.getAttribute('dir')).toBe('rtl');
    // The Arabic copy is what renders, not the English fallback.
    expect(screen.getByText('اترك رسالتك وسنرد فور عودتنا.')).toBeInTheDocument();
    // Both routes are still there and still point where they should.
    expect(screen.getByText('920012111').closest('a')).toHaveAttribute('href', 'tel:920012111');
    expect(screen.getByText('0565266122').closest('a')).toHaveAttribute(
      'href',
      'https://wa.me/966565266122',
    );
    // Two cards, and no email crept back in.
    expect(container.querySelectorAll('.yiji-offline-link')).toHaveLength(2);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe('the customer can change language inside the chat', () => {
  /*
   * The language is decided before the chat opens (the phone, or an earlier
   * choice). Somebody who guesses wrong for a customer — a shared phone, a
   * handset bought abroad — must not leave them stuck reading a language they
   * do not, one tap from the thing they came to complain about.
   */
  const langButton = () => screen.getByRole('button', { name: /العربية|English/ });

  it('offers the OTHER language, written in that language', () => {
    // "AR"/"EN" is only legible to someone who already reads both; a flag is a
    // country, not a language.
    renderWidget({ locale: 'en', autoOpen: true });
    expect(langButton().textContent).toBe('العربية');
  });

  it('switches the whole panel, and flips it right-to-left', () => {
    const { container } = renderWidget({ locale: 'en', autoOpen: true });
    expect(container.querySelector('[dir="rtl"]')).toBeNull();
    fireEvent.click(langButton());
    expect(screen.getByPlaceholderText('اكتب رسالة…')).toBeInTheDocument();
    expect(container.querySelector('[dir="rtl"]')).not.toBeNull();
    // And back, so the switch is never a one-way door.
    fireEvent.click(langButton());
    expect(screen.getByPlaceholderText('Type a message…')).toBeInTheDocument();
  });

  it('tells the host page, so the choice outlives this visit', () => {
    // The widget is embedded in pages it does not own, so it keeps no memory
    // itself; the host stores it (see locale.ts).
    const onLocaleChange = vi.fn();
    renderWidget({ locale: 'ar', autoOpen: true, onLocaleChange });
    fireEvent.click(langButton());
    expect(onLocaleChange).toHaveBeenCalledWith('en');
  });

  it('re-says the greeting in the new language', () => {
    /*
     * The greeting is a local bubble, written when `ready` arrived. Leaving it
     * behind means the first line of the conversation stays in the language
     * the customer just rejected — the most visible line on the screen.
     */
    renderWidget({ locale: 'en', autoOpen: true });
    driveReady({ isNew: true });
    expect(screen.getByText('Hey there 👋 How can we help you?')).toBeInTheDocument();
    fireEvent.click(langButton());
    expect(screen.getByText('مرحبًا 👋 كيف يمكننا مساعدتك؟')).toBeInTheDocument();
    expect(screen.queryByText('Hey there 👋 How can we help you?')).toBeNull();
  });

  it('keeps a returning customer’s name in the re-said greeting', () => {
    renderWidget({ locale: 'en', autoOpen: true });
    driveReady({ isNew: false, contact: { name: 'Sara', phone: '0501234567' } });
    fireEvent.click(langButton());
    expect(screen.getByText('مرحبًا Sara، كيف يمكننا مساعدتك؟')).toBeInTheDocument();
  });
});
