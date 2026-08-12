import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';
import type { ChatTiming } from '@yiji/reports';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown> & { defaultValue?: string }) => {
      let s = (o?.defaultValue ?? k) as string;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(val));
        }
      }
      return s;
    },
    i18n: { language: 'en', changeLanguage: vi.fn(), dir: () => 'ltr' },
  }),
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const inbox = vi.hoisted(() => ({ useAgents: vi.fn() }));
vi.mock('../src/features/inbox/api.js', () => inbox);

const perf = vi.hoisted(() => ({ useChatTimings: vi.fn() }));
vi.mock('../src/features/performance/api.js', () => perf);

import { AgentPerformancePage } from '../src/features/performance/AgentPerformancePage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AgentPerformancePage />, { wrapper: Wrapper });
}

const chat = (over: Partial<ChatTiming> = {}): ChatTiming => ({
  conversationId: 'c1',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: '2026-08-13T10:00:00.000Z',
  firstAgentAt: '2026-08-13T10:01:00.000Z',
  solvedAt: '2026-08-13T10:30:00.000Z',
  ...over,
});

// One fast chat, one slow one, one nobody ever answered — the three cases the
// two populations have to keep apart.
const timings: ChatTiming[] = [
  chat({ conversationId: 'fast' }),
  chat({ conversationId: 'slow', firstAgentAt: '2026-08-13T10:20:00.000Z' }),
  chat({ conversationId: 'never', firstAgentAt: null, solvedAt: null }),
];

const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

beforeEach(() => {
  navigate.mockReset();
  inbox.useAgents.mockReturnValue({
    data: [{ id: 'a1', first_name: 'Sara', email: 'sara@yiji.test' }],
  });
  perf.useChatTimings.mockReturnValue({ data: timings, isLoading: false });
});

describe('AgentPerformancePage', () => {
  it('opens on the chats that missed the target, not on the flattering half', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /Not meeting SLA/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 5 min default target: the slow one and the unanswered one.
    expect(screen.getByRole('button', { name: /Not meeting SLA/ })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /Meeting SLA/ })).toHaveTextContent('1');
  });

  it('never blends a chat into both populations', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(within(row('Sara')).getByText('2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Meeting SLA/ }));
    const cells = within(row('Sara')).getAllByRole('cell');
    // The one fast chat, answered, with nothing unanswered hiding in it.
    expect(cells[1]).toHaveTextContent('1');
    expect(cells[2]).toHaveTextContent('0');
    expect(cells[3]).toHaveTextContent('1m 0s');
  });

  it('shows unanswered chats as their own number instead of averaging them as 0s', () => {
    renderPage();
    const cells = within(row('Sara')).getAllByRole('cell');
    // Agent, chats, no-reply, avg first, median first, solved, avg solve.
    expect(cells[1]).toHaveTextContent('2');
    expect(cells[2]).toHaveTextContent('1');
    // 20 minutes — the answered chat only. A 0 folded in would halve this.
    expect(cells[3]).toHaveTextContent('20m 0s');
  });

  it('re-splits the populations when the target changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const target = screen.getByRole('spinbutton');
    await user.clear(target);
    await user.type(target, '30');
    // At 30 minutes the slow chat is now inside the target; only the
    // unanswered one is left missing it.
    expect(screen.getByRole('button', { name: /Not meeting SLA/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Meeting SLA/ })).toHaveTextContent('2');
  });

  it('opens a chat from the population currently on screen', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(row('Sara'));
    // Viewing "missed", so it must not open the fast chat.
    expect(navigate).toHaveBeenCalledWith('/?conv=slow');
  });

  it('passes the filters through to the query rather than filtering after the fact', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    const last = perf.useChatTimings.mock.calls.at(-1)!;
    expect(last[0]).toMatchObject({ from: '2026-08-01' });
  });

  it('says nothing matched instead of drawing an empty table', () => {
    perf.useChatTimings.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText(/No chats match these filters/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('states what the numbers are measured from, so a low average cannot be misread', () => {
    renderPage();
    expect(screen.getByText(/Internal notes do not count as a reply/)).toBeInTheDocument();
  });
});
