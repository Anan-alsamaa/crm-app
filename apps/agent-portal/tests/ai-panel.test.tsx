import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en' },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'agent-1' } }),
}));

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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<AiPanel conversationId="c1" vendorId="v1" {...props} />, { wrapper });
}

beforeEach(() => vi.clearAllMocks());

describe('AiPanel — agent assistance', () => {
  it('offers the actions the operations team asked for', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest reply' })).toBeInTheDocument();
  });

  it('summarizes the conversation it was given', async () => {
    ai.summarize.mockResolvedValue({ summary: 'Customer is chasing a late order.' });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() =>
      expect(screen.getByText('Customer is chasing a late order.')).toBeInTheDocument(),
    );
    expect(ai.summarize).toHaveBeenCalledWith({ userId: 'agent-1', vendorId: 'v1' }, 'c1');
  });

  it('hands a suggested reply to the composer rather than the customer', async () => {
    // The whole point of the agent-facing design: the text lands in the draft
    // for the agent to edit and send. Nothing here reaches the customer.
    const onReplySuggested = vi.fn();
    ai.suggestReply.mockResolvedValue({ reply: 'Sorry about that, checking with the branch now.' });
    renderPanel({ onReplySuggested });
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() =>
      expect(onReplySuggested).toHaveBeenCalledWith(
        'Sorry about that, checking with the branch now.',
      ),
    );
  });

  it('passes the agent draft through so the suggestion builds on it', async () => {
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    renderPanel({ draft: 'we are looking into' });
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ draft: 'we are looking into' });
  });
});

describe('AiPanel — reply language', () => {
  it('defaults to English when the interface is English', async () => {
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ locale: 'en' });
  });

  it('starts on Arabic when the caller says so', async () => {
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    renderPanel({ locale: 'ar-SA' });
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ locale: 'ar' });
  });

  it('lets the agent switch to Arabic for one customer', async () => {
    // An agent working in an English portal answers an Arabic customer in
    // Arabic. The choice belongs to the conversation, not to the interface.
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'ar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ locale: 'ar' });
  });

  it('marks the active language for assistive tech, not just visually', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'en' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'ar' })).toHaveAttribute('aria-pressed', 'false');
  });
});
