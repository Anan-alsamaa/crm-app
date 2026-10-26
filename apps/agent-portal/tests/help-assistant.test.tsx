import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * i18n: return the defaultValue and interpolate {{placeholders}} so the copy
 * the component actually ships (including limits/times) is what we assert on.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let out = (opts?.defaultValue as string | undefined) ?? key;
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (k === 'defaultValue') continue;
        out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      }
      return out;
    },
  }),
}));

vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

const ai = vi.hoisted(() => ({ helpAssistant: vi.fn() }));
vi.mock('../src/lib/ai-client.js', () => ({ ai }));

import { HelpAssistant } from '../src/features/help-assistant/HelpAssistant.js';

function renderHelp() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<HelpAssistant />, { wrapper: Wrapper });
}

/*
 * One user-event session per test, with the inter-keystroke delay OFF.
 *
 * These tests failed only in CI, never locally, for several releases. The
 * difference is load, not platform: CI runs both portals' suites concurrently
 * (`pnpm -r`), while the local gate runs --workspace-concurrency=1. By default
 * user-event waits on a real setTimeout between keystrokes, and under that
 * contention the typing never landed — the character counter still read 0/500
 * straight after typing "hi", so `canSend` stayed false, the Ask button stayed
 * disabled, and every assertion downstream of a submit failed.
 *
 * `delay: null` types synchronously, removing the timer dependency altogether.
 * setup() (rather than the direct userEvent.click API, which starts an implicit
 * session per call) is also the supported pattern for React 18 act() handling.
 */
let user: ReturnType<typeof userEvent.setup>;

async function openPanel() {
  await user.click(screen.getByRole('button', { name: 'Ask AI help' }));
  // Wait for the portalled Drawer to actually commit before anyone queries
  // inside it; asserting synchronously is what made these tests CI-fragile.
  await screen.findByRole('dialog');
}

beforeEach(() => {
  user = userEvent.setup({ delay: null });
  ai.helpAssistant.mockReset();
});

describe('HelpAssistant (agent portal)', () => {
  it('opens the panel from the top-bar launcher', async () => {
    renderHelp();
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
    await openPanel();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Your question')).toBeInTheDocument();
  });

  it('submitting a question renders the answer', async () => {
    ai.helpAssistant.mockResolvedValueOnce({
      answer: 'Open the ticket and use the Assignee menu.',
      offTopic: false,
    });
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByText('Open the ticket and use the Assignee menu.')).toBeInTheDocument(),
    );
    // Third argument is the replayed transcript — empty on the first turn.
    expect(ai.helpAssistant).toHaveBeenCalledWith(
      { userId: 'agent-1', vendorId: 'global' },
      'How do I reassign a ticket?',
      [],
      undefined,
    );
  });

  it('marks an off-topic answer as out of scope', async () => {
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'I only cover this CRM.', offTopic: true });
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'What is the weather?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByText('Out of scope')).toBeInTheDocument());
    // The refusal text itself comes from the gateway and is shown in the
    // bubble; the panel no longer repeats an explanation next to it.
    expect(screen.getByText('I only cover this CRM.')).toBeInTheDocument();
  });

  it('renders the daily allowance and reset time on quota_exceeded', async () => {
    ai.helpAssistant.mockRejectedValueOnce(
      Object.assign(new Error('quota'), {
        status: 429,
        code: 'quota_exceeded',
        scope: 'daily',
        limit: 20,
        resetAt: '2026-07-29T00:00:00.000Z',
      }),
    );
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/daily AI help allowance \(20\)/),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/It resets at/);
  });

  it('renders the disabled message on feature_disabled', async () => {
    ai.helpAssistant.mockRejectedValueOnce(
      Object.assign(new Error('off'), { status: 403, code: 'feature_disabled' }),
    );
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'AI help is turned off by your administrator.',
      ),
    );
  });

  it('renders a retry delay on rate_limited', async () => {
    ai.helpAssistant.mockRejectedValueOnce(
      Object.assign(new Error('slow down'), {
        status: 429,
        code: 'rate_limited',
        scope: 'user',
        retryAfterMs: 4200,
      }),
    );
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Too many requests — try again in 5s.'),
    );
  });

  it('renders the not-configured message on 503', async () => {
    ai.helpAssistant.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { status: 503, code: 'not_configured' }),
    );
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('AI help isn’t configured yet.'),
    );
  });

  it('disables send for an empty or too-short question and counts characters', async () => {
    renderHelp();
    await openPanel();
    const send = screen.getByRole('button', { name: 'Ask' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Your question'), 'hi');
    expect(send).toBeDisabled();
    // Assert the counter once React has committed the keystrokes. Reading it
    // synchronously is exactly what failed in CI ("expected 2/500, got 0/500").
    await waitFor(() =>
      expect(screen.getByTestId('help-assistant-counter')).toHaveTextContent('2/500'),
    );
    await user.type(screen.getByLabelText('Your question'), 'ya');
    expect(send).toBeEnabled();
    expect(ai.helpAssistant).not.toHaveBeenCalled();
  });

  it('replays the session transcript so follow-ups have context', async () => {
    ai.helpAssistant
      .mockResolvedValueOnce({
        answer: 'Open the ticket and use the Assignee menu.',
        offTopic: false,
      })
      .mockResolvedValueOnce({ answer: 'Only the assigned agent sees it.', offTopic: false });
    renderHelp();
    await openPanel();

    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Open the ticket and use the Assignee menu.');

    // The composer clears, so the follow-up is typed into an empty box.
    await user.type(screen.getByLabelText('Your question'), 'And who can see it?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Only the assigned agent sees it.');

    // Second call must carry BOTH earlier turns, oldest first — that context is
    // the whole point; without it the gateway refuses follow-ups as off-topic.
    expect(ai.helpAssistant).toHaveBeenNthCalledWith(
      2,
      { userId: 'agent-1', vendorId: 'global' },
      'And who can see it?',
      [
        { role: 'user', content: 'How do I reassign a ticket?' },
        { role: 'assistant', content: 'Open the ticket and use the Assignee menu.' },
      ],
      undefined,
    );

    // Both questions stay on screen: it reads as a conversation, not a lookup.
    expect(screen.getByText('How do I reassign a ticket?')).toBeInTheDocument();
  });
});

describe('HelpAssistant — the panel a reader can actually read', () => {
  /**
   * The reported failure: opening Aura showed her greeting already scrolled
   * off its own top edge, beginning mid-sentence under a header that had
   * stayed put because it was sticky.
   *
   * Cause: a scroll anchor sat at the very bottom of the feed — below the
   * greeting and four starter chips — and `scrollIntoView` was called on it
   * unconditionally on mount. An opening greeting is the TOP of a
   * conversation, not the bottom, and there is nothing yet to scroll past.
   */
  it('does not scroll a conversation that has not started', async () => {
    /*
     * Both routes are watched, not just the current one. jsdom implements
     * neither, so a component that reverted to `scrollIntoView` on an anchor —
     * exactly the shape of the original bug — would sail past a spy that only
     * knew about `scrollTo`, and this test would go green on the broken code.
     */
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    renderHelp();
    await openPanel();
    expect(screen.getByRole('heading', { name: /I’m Aura/ })).toBeInTheDocument();
    expect(scrollTo, 'the opening greeting must not be scrolled away').not.toHaveBeenCalled();
    expect(scrollIntoView, 'nor by an anchor below the starter chips').not.toHaveBeenCalled();
  });

  /**
   * And the other half: the transcript must be REACHABLE.
   *
   * The bottom-anchoring was `justify-content: flex-end`, which overflows past
   * a scroll container's START edge — and content that overflows the start edge
   * of a flex container cannot be scrolled to. The browser reports
   * scrollHeight === clientHeight and the earliest messages are simply gone.
   * An auto margin on the first child anchors the same way and resolves to
   * zero once the content overflows, so scrolling works.
   */
  it('anchors messages to the foot WITHOUT putting the earliest out of reach', async () => {
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'Use the Assignee menu.', offTopic: false });
    const { container } = renderHelp();
    await openPanel();

    const feed = () => container.ownerDocument.querySelector('[aria-live="polite"]') as HTMLElement;
    // Opening state: anchored to the TOP, or the greeting and its starter
    // questions drop to the floor of a tall empty rectangle.
    expect(feed().className).not.toContain('mt-auto');
    expect(feed().className).not.toContain('justify-end');

    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Use the Assignee menu.');

    // Underway: anchored to the foot by an auto margin, never by justify-end.
    expect(feed().className).toContain('[&>*:first-child]:mt-auto');
    expect(feed().className, 'justify-end makes overflow above unreachable').not.toContain(
      'justify-end',
    );
  });

  it('gives the transcript its own scroller, so the header cannot be scrolled away', async () => {
    const { container } = renderHelp();
    await openPanel();
    const feed = container.ownerDocument.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(feed.className).toContain('overflow-y-auto');
    // The header used to be `sticky top-0` INSIDE the drawer's own scroller,
    // which works right up until something scrolls the body — and then the
    // header stays while the first message slides underneath it.
    const header = screen.getByText('CRM assistant').closest('div')?.parentElement;
    expect(header?.className ?? '').not.toContain('sticky');
  });
});

describe('HelpAssistant — the redesigned panel (2026-10-26)', () => {
  it('Enter sends the question; Shift+Enter only starts a new line', async () => {
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'Use the Assignee menu.', offTopic: false });
    renderHelp();
    await openPanel();
    const field = screen.getByLabelText('Your question') as HTMLTextAreaElement;

    await user.type(field, 'How do I reassign{Shift>}{Enter}{/Shift}a ticket?');
    expect(ai.helpAssistant).not.toHaveBeenCalled();
    expect(field.value).toBe('How do I reassign\na ticket?');

    await user.type(field, '{Enter}');
    await screen.findByText('Use the Assignee menu.');
    expect(ai.helpAssistant).toHaveBeenCalledTimes(1);
    expect(ai.helpAssistant.mock.calls[0]?.[1]).toBe('How do I reassign\na ticket?');
    // The composer clears for the follow-up.
    expect(field.value).toBe('');
  });

  it('Enter on a too-short question sends nothing', async () => {
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'hi{Enter}');
    expect(ai.helpAssistant).not.toHaveBeenCalled();
  });

  it('a starter card asks its question in one click', async () => {
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'Press Quick replies.', offTopic: false });
    renderHelp();
    await openPanel();
    expect(screen.getByText('Try asking')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Quick replies/ }));
    await screen.findByText('Press Quick replies.');
    expect(ai.helpAssistant).toHaveBeenCalledWith(
      { userId: 'agent-1', vendorId: 'global' },
      'How do I insert a quick reply in a chat?',
      [],
      undefined,
    );
    // Underway, the starters make way for the conversation - which does NOT
    // repeat Aura's greeting: the welcome screen already said hello.
    expect(screen.queryByText('Try asking')).toBeNull();
    expect(screen.queryByText(/I am Aura/)).toBeNull();
  });

  it('starts a new chat back on the empty state', async () => {
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'Use the Assignee menu.', offTopic: false });
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?{Enter}');
    await screen.findByText('Use the Assignee menu.');
    await user.click(screen.getByRole('button', { name: 'Start a new chat' }));
    expect(screen.queryByText('Use the Assignee menu.')).toBeNull();
    expect(screen.getByText('Try asking')).toBeInTheDocument();
  });

  it('a failed question can be asked again without showing it twice', async () => {
    ai.helpAssistant
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, code: 'upstream' }))
      .mockResolvedValueOnce({ answer: 'Use the Assignee menu.', offTopic: false });
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t get an answer.'),
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Use the Assignee menu.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText('How do I reassign a ticket?')).toHaveLength(1);
    // The retried question is not replayed as its own history.
    expect(ai.helpAssistant).toHaveBeenNthCalledWith(
      2,
      { userId: 'agent-1', vendorId: 'global' },
      'How do I reassign a ticket?',
      [],
      undefined,
    );
  });

  it('offers no retry where asking again cannot help', async () => {
    ai.helpAssistant.mockRejectedValueOnce(
      Object.assign(new Error('off'), { status: 403, code: 'feature_disabled' }),
    );
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I close a ticket?{Enter}');
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('copies one of Aura’s replies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'Use the Assignee menu.', offTopic: false });
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?{Enter}');
    await screen.findByText('Use the Assignee menu.');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Use the Assignee menu.');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('sets numbered steps as a list', async () => {
    ai.helpAssistant.mockResolvedValueOnce({
      answer: 'Here is how:\n1. Open the ticket.\n2. Use the Assignee menu.',
      offTopic: false,
    });
    renderHelp();
    await openPanel();
    await user.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?{Enter}');
    const step = await screen.findByText('Open the ticket.');
    expect(step.closest('ol')).not.toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('names the conversation and announces replies politely', async () => {
    renderHelp();
    await openPanel();
    const log = screen.getByRole('log', { name: 'Conversation with Aura' });
    expect(log).toHaveAttribute('aria-live', 'polite');
  });
});
