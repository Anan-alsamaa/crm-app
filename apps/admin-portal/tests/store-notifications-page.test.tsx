import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

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

const api = vi.hoisted(() => ({
  useStoreNotifyRules: vi.fn(),
  useSetStoreNotifyRule: vi.fn(),
  useStoreNotifications: vi.fn(),
  useSenderNames: vi.fn(),
}));
vi.mock('../src/features/store-notifications/api.js', () => api);

/* The ticket types agents can pick, as production's Dropdown values hold them. */
const LIVE_TYPES = [
  'Accuracy',
  'Cleanness',
  'Driver attitude',
  'Foreign object found',
  'Hospitality',
  'Instore preparation late order',
  'Late order',
  'Missing condiments',
  'Missing item',
  'Product',
  'Roach found',
  'Technical issue',
  'Wrong order',
  'Other',
];
const lists = vi.hoisted(() => ({ useOptionLists: vi.fn() }));
vi.mock('../src/lib/option-lists.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/option-lists.js')>()),
  useOptionLists: lists.useOptionLists,
}));

import { StoreNotificationsPage } from '../src/features/store-notifications/StoreNotificationsPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<StoreNotificationsPage />, { wrapper: Wrapper });
}

const mutate = vi.fn();

beforeEach(() => {
  mutate.mockReset();
  api.useStoreNotifyRules.mockReturnValue({
    data: [
      { id: 'r1', complaint_type: 'Missing item', enabled: true },
      // Considered and turned OFF — kept as a row, and must read as off.
      { id: 'r2', complaint_type: 'Technical issue', enabled: false },
    ],
    isLoading: false,
  });
  api.useSetStoreNotifyRule.mockReturnValue({ mutate, isPending: false });
  api.useStoreNotifications.mockReturnValue({ data: [], isLoading: false });
  api.useSenderNames.mockReturnValue({ data: undefined });
  lists.useOptionLists.mockReturnValue({
    data: { complaint_type: LIVE_TYPES },
    isLoading: false,
  });
});

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

describe('StoreNotificationsPage', () => {
  it('shows the live ticket types, each as a new ticket of that type does today', () => {
    renderPage();
    // Set by the Administrator.
    expect(pressed('Missing item')).toBe('true');
    expect(pressed('Technical issue')).toBe('false');
    // Not set: the default - on, except Driver attitude, Technical issue, Other.
    expect(pressed('Wrong order')).toBe('true');
    expect(pressed('Instore preparation late order')).toBe('true');
    expect(pressed('Driver attitude')).toBe('false');
    expect(pressed('Other')).toBe('false');
    // Retired built-in values are not offered.
    expect(screen.queryByRole('button', { name: 'Order cold' })).not.toBeInTheDocument();
    expect(screen.getByText('11 of 14 selected')).toBeInTheDocument();
  });

  it('reuses a type’s existing row instead of stacking a second one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Technical issue' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        complaintType: 'Technical issue',
        enabled: true,
        existingId: 'r2',
      }),
      expect.anything(),
    );
  });

  it('turning off a type that is on by default creates its row, set off', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Wrong order' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        complaintType: 'Wrong order',
        enabled: false,
        existingId: undefined,
      }),
      expect.anything(),
    );
  });

  it('turning on a type that is off by default creates its row, set on', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Other' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ complaintType: 'Other', enabled: true, existingId: undefined }),
      expect.anything(),
    );
  });

  it('says out loud when every type is turned off', () => {
    api.useStoreNotifyRules.mockReturnValue({
      data: LIVE_TYPES.map((t, i) => ({ id: `r${i}`, complaint_type: t, enabled: false })),
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText(/no branch is told about anything/i)).toBeInTheDocument();
    expect(screen.getByText('0 of 14 selected')).toBeInTheDocument();
  });

  it('shows the queue carrying the order, its items, the description and the notes', () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'n1',
          complaint_type: 'Missing item',
          order_id: '946641',
          order_items: [
            { name: 'Double burger', qty: 2 },
            { name: 'Fries', qty: 1 },
          ],
          description: 'Two burgers missing.',
          resolution_notes: 'Refunded in full.',
          status: 'queued',
          sent_at: null,
          date_created: '2026-08-13T10:00:00.000Z',
          ticket: { id: 't1', subject: 'Missing item' },
          store: { id: 's1', code: 'LCP-002', name: 'Marina Mall 2' },
        },
      ],
    });
    renderPage();
    const row = screen.getByRole('row', { name: /LCP-002/ });
    // The order leads: a branch looks the ticket up by order number before
    // it reads what went wrong.
    expect(within(row).getByText('#946641')).toBeInTheDocument();
    expect(within(row).getByText(/2× Double burger, 1× Fries/)).toBeInTheDocument();
    expect(within(row).getByText(/Two burgers missing/)).toBeInTheDocument();
    expect(within(row).getByText(/Refunded in full/)).toBeInTheDocument();
    expect(within(row).getByText('queued')).toBeInTheDocument();
  });

  it('states an absent field rather than leaving a blank cell', () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'n1',
          complaint_type: 'Missing item',
          order_id: null,
          order_items: null,
          description: 'Two burgers missing.',
          resolution_notes: null,
          status: 'queued',
          sent_at: null,
          date_created: '2026-08-13T10:00:00.000Z',
          ticket: { id: 't1', subject: 'Missing item' },
          store: { id: 's1', code: 'LCP-002', name: 'Marina Mall 2' },
        },
      ],
    });
    renderPage();
    const row = screen.getByRole('row', { name: /LCP-002/ });
    // A blank cell reads as a rendering bug; "not written" is a fact about the
    // ticket. Two here: the order that was never attached, and the notes
    // nobody typed.
    expect(within(row).getAllByText('not written')).toHaveLength(2);
  });

  /* Owner, 26 Nov 2026: a custom message (no ticket) must be listed clearly
     and apart from a ticket's notification. */
  it('labels each row Ticket or Custom message, with who sent the custom one', () => {
    api.useSenderNames.mockReturnValue({ data: new Map([['u-nada', 'Nada Ali']]) });
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'c1',
          kind: 'custom',
          user_created: 'u-nada',
          complaint_type: null,
          order_id: '1350658',
          order_items: null,
          description: 'Customer is on the way to collect.\nPlease have it ready.',
          resolution_notes: null,
          status: 'sent',
          sent_at: '2026-11-26T08:11:11.000Z',
          date_created: '2026-11-26T08:10:00.000Z',
          ticket: null,
          store: { id: 's9', code: 'LCP-095', name: 'One Square RYD' },
        },
        {
          id: 'n1',
          complaint_type: 'Missing item',
          order_id: '946641',
          order_items: null,
          description: 'Two burgers missing.',
          resolution_notes: 'Refunded.',
          status: 'queued',
          sent_at: null,
          date_created: '2026-11-26T07:00:00.000Z',
          ticket: { id: 't1', subject: 'Missing item' },
          store: { id: 's1', code: 'LCP-002', name: 'Marina Mall 2' },
        },
      ],
    });
    renderPage();
    const custom = screen.getByRole('row', { name: /LCP-095/ });
    expect(within(custom).getByText('Custom message')).toBeInTheDocument();
    expect(within(custom).getByText('by Nada Ali')).toBeInTheDocument();
    expect(within(custom).getByText('#1350658')).toBeInTheDocument();
    // Printed as written, so shown whole - and never as "not written" notes.
    expect(
      within(custom).getByText(/Customer is on the way to collect\.\s+Please have it ready\./),
    ).toBeInTheDocument();
    expect(within(custom).queryByText('not written')).toBeNull();
    const ticket = screen.getByRole('row', { name: /LCP-002/ });
    expect(within(ticket).getByText('Ticket')).toBeInTheDocument();
    expect(within(ticket).getByText('Missing item')).toBeInTheDocument();
  });

  it('a custom message whose sender cannot be named still says it had no ticket', () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'c1',
          kind: 'custom',
          user_created: 'u-x',
          description: 'Please call WeCare.',
          status: 'queued',
          sent_at: null,
          date_created: null,
          ticket: null,
          store: { id: 's9', code: 'LCP-095', name: 'One Square RYD' },
        },
      ],
    });
    renderPage();
    expect(screen.getByText('No ticket')).toBeInTheDocument();
  });

  /* Owner, 26 Nov 2026: "ensure the user who sends a message and the message
     and everything is tracked". */
  it('shows the sender kept on the message, with their employee id, even if the account is gone', () => {
    api.useSenderNames.mockReturnValue({ data: new Map() });
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'c1',
          kind: 'custom',
          user_created: 'u-deleted',
          sender_name: 'Nada Ali',
          sender_login: '04174',
          description: 'Please call WeCare.',
          status: 'sent',
          attempts: 1,
          sent_at: '2026-11-26T09:29:11.000Z',
          date_created: '2026-11-26T09:28:48.000Z',
          ticket: null,
          store: { id: 's9', code: 'LCP-095', name: 'One Square RYD' },
        },
      ],
    });
    renderPage();
    const row = screen.getByRole('row', { name: /LCP-095/ });
    expect(within(row).getByText('by Nada Ali (04174)')).toBeInTheDocument();
    expect(within(row).getByText(/^Queued /)).toBeInTheDocument();
    expect(within(row).getByText(/^Sent /)).toBeInTheDocument();
  });

  it("a failed message shows SaraPOS's reason and how many tries", () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'c2',
          kind: 'custom',
          sender_name: 'Nada Ali',
          sender_login: '04174',
          description: 'Please call WeCare.',
          status: 'failed',
          attempts: 5,
          error: 'SaraPOS 500: outlet offline',
          sent_at: null,
          date_created: '2026-11-26T09:28:48.000Z',
          ticket: null,
          store: { id: 's9', code: 'LCP-095', name: 'One Square RYD' },
        },
      ],
    });
    renderPage();
    const row = screen.getByRole('row', { name: /LCP-095/ });
    expect(within(row).getByText('SaraPOS 500: outlet offline')).toBeInTheDocument();
    expect(within(row).getByText('5 attempts')).toBeInTheDocument();
    expect(within(row).queryByText(/^Sent /)).toBeNull();
  });

  it('pages through the whole history, 50 more at a time', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      complaint_type: 'Missing item',
      description: 'x',
      status: 'sent',
      sent_at: null,
      date_created: null,
      ticket: null,
      store: { id: 's1', code: `B-${i}`, name: 'Branch' },
    }));
    api.useStoreNotifications.mockReturnValue({ isLoading: false, data: many });
    renderPage();
    expect(api.useStoreNotifications).toHaveBeenLastCalledWith(50, 'all');
    await userEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    expect(api.useStoreNotifications).toHaveBeenLastCalledWith(100, 'all');
  });

  it('filters the queue: all, from tickets, custom messages', async () => {
    renderPage();
    expect(api.useStoreNotifications).toHaveBeenLastCalledWith(50, 'all');
    await userEvent.click(screen.getByRole('button', { name: 'Custom messages' }));
    expect(api.useStoreNotifications).toHaveBeenLastCalledWith(50, 'custom');
    expect(screen.getByRole('button', { name: 'Custom messages' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'From tickets' }));
    expect(api.useStoreNotifications).toHaveBeenLastCalledWith(50, 'ticket');
  });

  it('says where the notifications go', async () => {
    api.useStoreNotifications.mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 'n1',
          complaint_type: 'Missing item',
          description: 'x',
          resolution_notes: 'y',
          status: 'queued',
          sent_at: null,
          date_created: null,
          ticket: null,
          store: { id: 's1', code: 'LCP-002', name: 'Marina Mall 2' },
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Sent to each branch's SaraPOS/)).toBeInTheDocument(),
    );
  });
});
