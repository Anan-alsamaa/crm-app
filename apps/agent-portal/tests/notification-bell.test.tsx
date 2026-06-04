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
  }),
}));

// Socket: getSocket resolves to a no-op emitter so the effect doesn't touch the network.
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock('../src/lib/socket.js', () => ({ getSocket: vi.fn().mockResolvedValue(socket) }));

const hooks = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  useMarkNotificationRead: vi.fn(),
}));
vi.mock('../src/features/notifications/api.js', () => hooks);

import { NotificationBell } from '../src/features/notifications/NotificationBell.js';

function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<NotificationBell />, { wrapper: Wrapper });
}

const unreadNotif = {
  id: 'n1',
  type: 'mention',
  title: 'You were mentioned',
  body: 'Check the thread',
  link: '/inbox',
  read_at: null,
  date_created: '2026-06-04T10:00:00.000Z',
};

beforeEach(() => {
  socket.on.mockReset();
  hooks.useNotifications.mockReset();
  hooks.useMarkNotificationRead.mockReset();
  hooks.useMarkNotificationRead.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('NotificationBell', () => {
  it('renders the bell with an unread count badge', () => {
    hooks.useNotifications.mockReturnValue({ data: [unreadNotif] });
    renderBell();
    expect(screen.getByLabelText('notifications.title')).toBeInTheDocument();
    expect(screen.getByLabelText('1 unread')).toBeInTheDocument();
  });

  it('opens the dropdown and lists the unread notification', async () => {
    hooks.useNotifications.mockReturnValue({ data: [unreadNotif] });
    renderBell();
    await userEvent.click(screen.getByLabelText('notifications.title'));
    await waitFor(() => expect(screen.getByText('You were mentioned')).toBeInTheDocument());
    expect(screen.getByText('Check the thread')).toBeInTheDocument();
  });

  it('shows the caught-up empty state when there are no unread items', async () => {
    hooks.useNotifications.mockReturnValue({ data: [] });
    renderBell();
    await userEvent.click(screen.getByLabelText('notifications.title'));
    await waitFor(() => expect(screen.getAllByText('All caught up').length).toBeGreaterThan(0));
  });

  it('marks a notification read on click', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useMarkNotificationRead.mockReturnValue({ mutateAsync });
    hooks.useNotifications.mockReturnValue({ data: [unreadNotif] });
    renderBell();
    await userEvent.click(screen.getByLabelText('notifications.title'));
    await userEvent.click(await screen.findByText('Mark read'));
    expect(mutateAsync).toHaveBeenCalledWith('n1');
  });
});
