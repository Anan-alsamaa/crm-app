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
  useAuth: () => ({ user: { id: 'admin-1' } }),
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

describe('HelpAssistant (admin portal)', () => {
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
      { userId: 'admin-1' },
      'How do I reassign a ticket?',
      [],
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
      { userId: 'admin-1' },
      'And who can see it?',
      [
        { role: 'user', content: 'How do I reassign a ticket?' },
        { role: 'assistant', content: 'Open the ticket and use the Assignee menu.' },
      ],
    );

    // Both questions stay on screen: it reads as a conversation, not a lookup.
    expect(screen.getByText('How do I reassign a ticket?')).toBeInTheDocument();
  });
});
