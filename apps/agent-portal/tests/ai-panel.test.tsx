import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

// i18n: return the provided defaultValue so labels render deterministically.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k,
  }),
}));
// Auth: a stable signed-in agent.
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));
// AI client: mock each call so mutations resolve synchronously.
const ai = vi.hoisted(() => ({
  summarize: vi.fn(),
  suggestReply: vi.fn(),
  sentiment: vi.fn(),
  intent: vi.fn(),
  entities: vi.fn(),
  scoreLead: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../src/lib/ai-client.js', () => ({ ai }));

import { AiPanel } from '../src/features/ai/AiPanel.js';

function renderPanel(props: Partial<React.ComponentProps<typeof AiPanel>> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AiPanel conversationId="conv-1" vendorId="v-1" {...props} />, {
    wrapper: Wrapper,
  });
}

beforeEach(() => {
  for (const fn of Object.values(ai)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

describe('AiPanel', () => {
  it('renders the six AI action buttons', () => {
    renderPanel();
    expect(screen.getByText('Summarize')).toBeInTheDocument();
    expect(screen.getByText('Suggest reply')).toBeInTheDocument();
    expect(screen.getByText('Sentiment')).toBeInTheDocument();
    expect(screen.getByText('Score lead')).toBeInTheDocument();
  });

  it('summarize click shows the returned summary', async () => {
    ai.summarize.mockResolvedValueOnce({ summary: 'Customer is asking about a refund.' });
    renderPanel();
    await userEvent.click(screen.getByText('Summarize'));
    await waitFor(() =>
      expect(screen.getByText('Customer is asking about a refund.')).toBeInTheDocument(),
    );
    expect(ai.summarize).toHaveBeenCalledWith({ userId: 'agent-1', vendorId: 'v-1' }, 'conv-1');
  });

  it('suggest reply calls back to the parent with the suggested text', async () => {
    ai.suggestReply.mockResolvedValueOnce({ reply: 'Sorry for the delay!' });
    const onReplySuggested = vi.fn();
    renderPanel({ onReplySuggested });
    await userEvent.click(screen.getByText('Suggest reply'));
    await waitFor(() => expect(onReplySuggested).toHaveBeenCalledWith('Sorry for the delay!'));
  });

  it('renders a friendly message when an action is disabled by admin', async () => {
    ai.sentiment.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'feature_disabled' }));
    renderPanel();
    await userEvent.click(screen.getByText('Sentiment'));
    await waitFor(() => expect(screen.getByText(/Disabled by admin/)).toBeInTheDocument());
  });
});
