import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { RouteError } from '../src/components/RouteError.js';

describe('RouteError', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the alert with title, body and both action buttons', () => {
    render(<RouteError onRetry={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('errors.pageTitle')).toBeInTheDocument();
    expect(screen.getByText('errors.pageBody')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'errors.retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'errors.reload' })).toBeInTheDocument();
  });

  it('invokes onRetry when the retry button is clicked', async () => {
    const onRetry = vi.fn();
    render(<RouteError onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'errors.retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reloads the window when the reload button is clicked', async () => {
    const reload = vi.fn();
    // window.location.reload is not implemented in jsdom; replace it.
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
    });
    render(<RouteError onRetry={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'errors.reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
