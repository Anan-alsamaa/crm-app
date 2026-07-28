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

async function openPanel() {
  await userEvent.click(screen.getByRole('button', { name: 'Ask AI help' }));
}

beforeEach(() => {
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
    await userEvent.type(screen.getByLabelText('Your question'), 'How do I reassign a ticket?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByText('Open the ticket and use the Assignee menu.')).toBeInTheDocument(),
    );
    expect(ai.helpAssistant).toHaveBeenCalledWith(
      { userId: 'agent-1', vendorId: 'global' },
      'How do I reassign a ticket?',
    );
  });

  it('marks an off-topic answer as out of scope', async () => {
    ai.helpAssistant.mockResolvedValueOnce({ answer: 'I only cover this CRM.', offTopic: true });
    renderHelp();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Your question'), 'What is the weather?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getByText('Out of scope')).toBeInTheDocument());
    expect(screen.getByText(/only answers questions about this CRM/)).toBeInTheDocument();
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
    await userEvent.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
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
    await userEvent.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
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
    await userEvent.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
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
    await userEvent.type(screen.getByLabelText('Your question'), 'How do I close a ticket?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('AI help isn’t configured yet.'),
    );
  });

  it('disables send for an empty or too-short question and counts characters', async () => {
    renderHelp();
    await openPanel();
    const send = screen.getByRole('button', { name: 'Ask' });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your question'), 'hi');
    expect(send).toBeDisabled();
    expect(screen.getByTestId('help-assistant-counter')).toHaveTextContent('2/500');
    await userEvent.type(screen.getByLabelText('Your question'), 'ya');
    expect(send).toBeEnabled();
    expect(ai.helpAssistant).not.toHaveBeenCalled();
  });
});
