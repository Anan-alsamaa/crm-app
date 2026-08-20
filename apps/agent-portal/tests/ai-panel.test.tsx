import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

const ui = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: ui,
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

beforeEach(() => {
  vi.clearAllMocks();
  ui.language = 'en';
});

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
    // The language rides along with EVERY action now, not only the reply —
    // an Arabic assistant that answers with an English summary has told the
    // agent the setting does not work.
    expect(ai.summarize).toHaveBeenCalledWith({ userId: 'agent-1', vendorId: 'v1' }, 'c1', 'en');
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
  it('summarises in the panel language, not the language of the chat', async () => {
    ai.summarize.mockResolvedValue({ summary: 'ملخص' });
    ui.language = 'ar';
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(ai.summarize).toHaveBeenCalled());
    expect(ai.summarize.mock.calls[0]![2]).toBe('ar');
  });

  it('follows the portal language when the agent has not chosen one', async () => {
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    ui.language = 'ar-SA';
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ locale: 'ar' });
  });

  it('lets the panel selector BEAT an English portal', async () => {
    // AR here, EN portal -> Arabic. The selector is the more specific
    // statement: it is about this customer, the portal is about the agent.
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    ui.language = 'en';
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'ar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ locale: 'ar' });
  });

  it('lets the panel selector BEAT an Arabic portal', async () => {
    // The other direction, which is the one that gets forgotten: EN here with
    // an Arabic portal must produce English, not Arabic.
    ai.suggestReply.mockResolvedValue({ reply: 'ok' });
    ui.language = 'ar';
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'en' }));
    await userEvent.click(screen.getByRole('button', { name: 'Suggest reply' }));
    await waitFor(() => expect(ai.suggestReply).toHaveBeenCalled());
    expect(ai.suggestReply.mock.calls[0]![2]).toMatchObject({ locale: 'en' });
  });

  it('marks the effective language for assistive tech, before anyone picks one', () => {
    ui.language = 'ar-SA';
    renderPanel();
    // Pressed without a click: the control shows which language the panel is
    // in, not merely which button was last used.
    expect(screen.getByRole('button', { name: 'ar' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'en' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers only actions that act on THIS chat', () => {
    // Search did not act on the conversation in front of the agent, and the
    // inbox has its own. Lead scoring is a sales idea with no meaning in a
    // complaints inbox — there are no leads, only complaints.
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Score lead' })).toBeNull();
  });

  it('classifies against the complaint types the ticket form offers', async () => {
    // A generic tag like "shipping_issue" is a translation job handed back to
    // the agent; the point is an answer they can use as-is.
    ai.intent.mockResolvedValue({ intent: 'Late order', confidence: 0.9 });
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Complaint type' }));
    await waitFor(() => expect(ai.intent).toHaveBeenCalled());
    const candidates = ai.intent.mock.calls[0]![2];
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).toContain('Late order');
  });
});
