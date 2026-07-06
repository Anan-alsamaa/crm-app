import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// i18next mock: return defaultValue when provided, else the key. RouteError
// calls t(key, { ns: 'common' }) with no defaultValue, so we assert on keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

import { RouteError } from '../src/components/RouteError.js';

describe('RouteError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the alert with title, body and both actions', () => {
    render(<RouteError onRetry={vi.fn()} />);

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('errors.pageTitle')).toBeInTheDocument();
    expect(screen.getByText('errors.pageBody')).toBeInTheDocument();
    expect(screen.getByText('errors.retry')).toBeInTheDocument();
    expect(screen.getByText('errors.reload')).toBeInTheDocument();
  });

  it('invokes onRetry when the retry button is clicked (generic-error recovery)', () => {
    const onRetry = vi.fn();
    render(<RouteError onRetry={onRetry} />);

    fireEvent.click(screen.getByText('errors.retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reloads the window when the reload button is clicked', () => {
    const reload = vi.fn();
    const original = window.location;
    // window.location.reload is not configurable in jsdom by default; replace it.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });

    render(<RouteError onRetry={vi.fn()} />);
    fireEvent.click(screen.getByText('errors.reload'));
    expect(reload).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: original,
    });
  });

  it('renders consistently for a route-error-response scenario (onRetry re-fetches the route)', () => {
    // The route ErrorBoundary passes an onRetry that re-runs the failed loader
    // regardless of whether the thrown value is an ErrorResponse or a plain
    // Error — RouteError itself only needs the retry callback.
    const onRetry = vi.fn();
    const { rerender } = render(<RouteError onRetry={onRetry} />);
    fireEvent.click(screen.getByText('errors.retry'));

    // Simulate a second failure of a different kind (generic Error) reusing the
    // same fallback and callback.
    rerender(<RouteError onRetry={onRetry} />);
    fireEvent.click(screen.getByText('errors.retry'));

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
