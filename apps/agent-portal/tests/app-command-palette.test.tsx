import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ logout: vi.fn() }) }));

const inbox = vi.hoisted(() => ({ useConversations: vi.fn() }));
const tickets = vi.hoisted(() => ({ useTickets: vi.fn() }));
vi.mock('../src/features/inbox/api.js', () => inbox);
vi.mock('../src/features/tickets/api.js', () => tickets);

// jsdom does not implement scrollIntoView, which the palette calls when its
// active item changes. Provide a no-op so the render does not throw.
Element.prototype.scrollIntoView = function scrollIntoView() {};

import { AppCommandPalette } from '../src/components/AppCommandPalette.js';

function renderPalette() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<AppCommandPalette />, { wrapper: Wrapper });
}

beforeEach(() => {
  inbox.useConversations.mockReturnValue({
    data: [
      { id: 'c1', contact: { name: 'Alice', email: 'a@x.com' }, status: 'open', priority: 'high' },
    ],
  });
  tickets.useTickets.mockReturnValue({
    data: [{ id: 't1', subject: 'Refund', status: 'open', priority: 'high', contact: null }],
  });
});

describe('AppCommandPalette', () => {
  it('mounts closed without rendering page commands', () => {
    renderPalette();
    // Closed: the navigation command labels are not in the DOM yet.
    expect(screen.queryByText('nav.inbox')).not.toBeInTheDocument();
  });

  it('opens on Cmd/Ctrl+K and shows the assembled command groups', async () => {
    renderPalette();
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.getByText('nav.inbox')).toBeInTheDocument());
    expect(screen.getByText('nav.tickets')).toBeInTheDocument();
    // Live data groups: conversation contact + ticket subject.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Refund')).toBeInTheDocument();
  });
});

/*
 * PROD, 2026-10-26: mounted on every page, the palette read every open chat
 * and every ticket ever (8,000+, unbounded) on each load and refocus of every
 * agent, and Directus blocked on it. Closed, it must ask for nothing; open, a
 * handful.
 */
describe('AppCommandPalette — loads only while open, and only a few', () => {
  it('asks for no chats and no tickets while closed', () => {
    inbox.useConversations.mockClear();
    tickets.useTickets.mockClear();
    renderPalette();
    const convOpts = inbox.useConversations.mock.calls.map((c) => c[1] as { enabled?: boolean });
    const tkOpts = tickets.useTickets.mock.calls.map((c) => c[0] as { enabled?: boolean });
    expect(convOpts.every((o) => o?.enabled === false)).toBe(true);
    expect(tkOpts.every((o) => o?.enabled === false)).toBe(true);
  });

  it('caps the chat preview at eight', () => {
    inbox.useConversations.mockClear();
    renderPalette();
    const opts = inbox.useConversations.mock.calls.map((c) => c[1] as { limit?: number });
    expect(opts.every((o) => o?.limit === 8)).toBe(true);
  });
});
