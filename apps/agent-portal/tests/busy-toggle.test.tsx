import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The Busy button says READY or BUSY in words and flips the moment it is
 * clicked; the server confirms behind it (owner, 2026-10-11).
 */
const producer = vi.hoisted(() => ({
  getBusy: vi.fn(async () => ({ busy: false, since: null })),
  setBusy: vi.fn(),
}));
vi.mock('../src/lib/job-producer.js', () => producer);
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k,
  }),
}));

import { BusyToggle } from '../src/components/BusyToggle.js';

function renderToggle() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BusyToggle />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  producer.setBusy.mockReset();
});

describe('BusyToggle', () => {
  it('reads Ready, and flips to Busy before the server has answered', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    producer.setBusy.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderToggle();
    const button = await screen.findByRole('button', { pressed: false });
    expect(button).toHaveTextContent('Ready');
    await userEvent.click(button);
    expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('Busy');
    resolve({ busy: true, since: new Date().toISOString() });
    await waitFor(() => expect(producer.setBusy).toHaveBeenCalledWith(true));
  });

  it('flips back when the server refuses', async () => {
    producer.setBusy.mockRejectedValue(new Error('403'));
    renderToggle();
    await userEvent.click(await screen.findByRole('button', { pressed: false }));
    await waitFor(() =>
      expect(screen.getByRole('button', { pressed: false })).toHaveTextContent('Ready'),
    );
  });
});
