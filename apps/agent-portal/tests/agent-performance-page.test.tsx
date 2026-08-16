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

// The comparison chart marks the viewer's own row, so the page reads the
// signed-in user.
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: { id: 'a1', first_name: 'Sara' } }),
}));

const perf = vi.hoisted(() => ({
  useChatTimings: vi.fn(),
  useCsatByConversation: vi.fn(() => ({ data: new Map<string, number>() })),
}));
vi.mock('../src/features/performance/api.js', () => perf);

import { AgentPerformancePage } from '../src/features/performance/AgentPerformancePage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<AgentPerformancePage />, { wrapper: Wrapper });
}

const chat = (over: Partial<ChatTiming> & { startedAt?: string | null } = {}) => ({
  conversationId: 'c1',
  agentId: 'a1',
  agentName: 'Sara',
  firstCustomerAt: '2026-08-13T10:00:00.000Z',
  firstAgentAt: '2026-08-13T10:01:00.000Z',
  solvedAt: '2026-08-13T10:30:00.000Z',
  startedAt: '2026-08-13T10:00:00.000Z',
  customer: 'Nora',
  orderId: '946641',
  ...over,
});

// One fast chat, one slow one, one nobody ever answered.
const timings = [
  chat({ conversationId: 'fast' }),
  chat({ conversationId: 'slow', firstAgentAt: '2026-08-13T10:20:00.000Z' }),
  chat({ conversationId: 'never', firstAgentAt: null, solvedAt: null }),
];

/** The headline number under a given tile label, read from the named landmark. */
function tile(label: string): string {
  const summary = screen.getByRole('region', { name: 'Summary' });
  const dt = within(summary)
    .getAllByText((_, el) => el?.textContent?.startsWith(label) === true)
    .filter((el) => el.tagName === 'DIV' && el.querySelector('div') === null)
    .at(-1)!;
  return dt.parentElement!.firstElementChild!.textContent!;
}

beforeEach(() => {
  navigate.mockReset();
  inbox.useAgents.mockReturnValue({
    data: [{ id: 'a1', first_name: 'Sara', email: 'sara@yiji.test' }],
  });
  perf.useChatTimings.mockReturnValue({ data: timings, isLoading: false });
});

describe('AgentPerformancePage', () => {
  it('leads with the five numbers, not with a chart to be decoded', () => {
    renderPage();
    expect(tile('Chats')).toBe('3');
    expect(tile('No reply yet')).toBe('1');
    // 20m and 1m over the two ANSWERED chats. The unanswered one folded in as a
    // 0 would report 7m and flatter the day.
    expect(tile('First response')).toBe('10m 30s');
  });

  it('counts a chat nobody answered against the target instead of excusing it', () => {
    renderPage();
    // Default 5-minute target: only the 1-minute chat met it, out of THREE.
    expect(tile('Answered in time')).toBe('33%');
  });

  it('re-scores against the target when it changes', async () => {
    const user = userEvent.setup();
    renderPage();
    const target = screen.getByRole('spinbutton');
    await user.clear(target);
    await user.type(target, '30');
    // At 30 minutes the slow chat now counts; the unanswered one still cannot.
    expect(tile('Answered in time')).toBe('67%');
  });

  it('charts the volume even when not one chat has been answered', () => {
    perf.useChatTimings.mockReturnValue({
      data: [chat({ conversationId: 'never', firstAgentAt: null, solvedAt: null })],
      isLoading: false,
    });
    renderPage();
    // The point of the volume series: the page still shows real work on a range
    // where every timing is legitimately missing, instead of reading as broken.
    const volume = screen.getByText('Who handled the chats').closest('section')!;
    expect(within(volume).getByText('Sara')).toBeInTheDocument();
    // And the timings chart says so plainly rather than drawing zeros.
    const speed = screen.getByText('How fast they replied').closest('section')!;
    expect(within(speed).getByText(/nothing to plot/)).toBeInTheDocument();
  });

  it('lists every chat behind the numbers, unanswered first', () => {
    renderPage();
    const breakdown = screen.getByRole('table', { name: 'Chat by chat' });
    const rows = within(breakdown).getAllByRole('row').slice(1); // drop the header
    // All three, not a filtered half: the table is where a number is checked.
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('No reply yet')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('20m 0s')).toBeInTheDocument();
  });

  it('opens the exact chat that was clicked, not the agent’s first', async () => {
    const user = userEvent.setup();
    renderPage();
    const breakdown = screen.getByRole('table', { name: 'Chat by chat' });
    await user.click(within(breakdown).getByText('20m 0s'));
    expect(navigate).toHaveBeenCalledWith('/?conv=slow');
  });

  it('hides the agent-versus-agent charts when one agent is selected', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText('Who handled the chats')).toBeInTheDocument();
    // SelectMenu's trigger is a combobox; each option is a button inside a li.
    await user.click(screen.getByRole('combobox', { name: 'Agent' }));
    await user.click(screen.getByRole('button', { name: 'Sara' }));
    // Comparing one person against themselves compares nothing.
    expect(screen.queryByText('Who handled the chats')).not.toBeInTheDocument();
    expect(screen.getByText('Chats per day')).toBeInTheDocument();
  });

  it('passes the filters through to the query rather than filtering after the fact', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    const last = perf.useChatTimings.mock.calls.at(-1)!;
    expect(last[0]).toMatchObject({ from: '2026-08-01' });
  });

  it('says nothing matched instead of drawing empty charts', () => {
    perf.useChatTimings.mockReturnValue({ data: [], isLoading: false });
    renderPage();
    expect(screen.getByText(/No chats match these filters/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('states what the numbers are measured from, so a low average cannot be misread', () => {
    renderPage();
    expect(screen.getByText(/internal notes do not count as a reply/)).toBeInTheDocument();
  });
});
