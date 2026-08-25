import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * THE ADMIN BELL.
 *
 * The admin portal had no notification surface at all, so a high-value coupon
 * alert had nowhere to land. These cover the two things that make it an alert
 * rather than a list: an unread count visible without opening anything, and a
 * click that takes you to the thing being alerted about.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const hooks = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  useMarkNotificationRead: vi.fn(),
}));
vi.mock('../src/features/notifications/api.js', () => hooks);

import { NotificationBell } from '../src/features/notifications/NotificationBell.js';

const COUPON = {
  id: 'n1',
  type: 'high_value_coupon',
  title: 'High-value coupon: SAR 500.00',
  body: 'A coupon worth SAR 500.00 (OPS-ABC) was requested and is waiting for approval.',
  link: '/coupon-approvals',
  read_at: null,
  date_created: '2026-08-25T10:00:00Z',
};

const markRead = vi.fn(async () => ({}));

function renderBell(rows: unknown[] = [COUPON]) {
  hooks.useNotifications.mockReturnValue({ data: rows });
  hooks.useMarkNotificationRead.mockReturnValue({ mutateAsync: markRead });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<NotificationBell />, { wrapper: Wrapper });
}

beforeEach(() => {
  navigate.mockClear();
  markRead.mockClear();
});

describe('admin notification bell', () => {
  it('shows the unread count WITHOUT the panel being opened', async () => {
    // The whole point is that nobody has to be looking in the right place.
    renderBell();
    expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument();
  });

  it('carries no badge when everything has been read', () => {
    renderBell([{ ...COUPON, read_at: '2026-08-25T11:00:00Z' }]);
    expect(screen.queryByRole('button', { name: /unread/i })).toBeNull();
    expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument();
  });

  it('shows the coupon amount in the alert itself', async () => {
    // An alert that says only "a coupon was requested" makes you go and look.
    renderBell();
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    // Both the title and the body carry it, which is the intent — the title is
    // what you read at a glance, the body is what tells you which coupon.
    expect(screen.getAllByText(/SAR 500\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/OPS-ABC/)).toBeInTheDocument();
  });

  it('takes the admin to the approvals queue, and marks it read on the way', async () => {
    renderBell();
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await userEvent.click(screen.getByText(/High-value coupon/i));
    expect(markRead).toHaveBeenCalledWith('n1');
    expect(navigate).toHaveBeenCalledWith('/coupon-approvals');
  });

  it('says so plainly when there is nothing, rather than showing an empty box', async () => {
    renderBell([]);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(screen.getByText(/nothing to read/i)).toBeInTheDocument();
  });
});
