import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * MV-4 (EMA-73): the reports and the dashboard can be narrowed to one vendor —
 * but the control exists only when 2+ vendors are active. With one vendor the
 * filter does not render and every query is exactly what it was.
 */

const db = vi.hoisted(() => ({
  vendors: [] as Array<{ id: string; name: string; status?: string }>,
}));
vi.mock('@directus/sdk', () => ({
  readItems: (collection: string) => ({ collection }),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: { request: vi.fn(async () => db.vendors) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en' },
  }),
}));

import {
  ReportVendorFilter,
  resetReportVendor,
  useReportVendor,
  useReportVendorFilter,
  withVendor,
} from '../src/lib/report-vendor.js';

/** What a report's loader would filter by. */
function LoaderProbe() {
  return <span data-testid="applied">{useReportVendorFilter() || '(all)'}</span>;
}

function Probe() {
  const rv = useReportVendor();
  return (
    <div>
      <span data-testid="show">{String(rv.show)}</span>
      <span data-testid="vendor">{rv.vendor}</span>
      <button type="button" onClick={() => rv.setVendor('v-two')}>
        pick
      </button>
      <ReportVendorFilter />
    </div>
  );
}

function renderProbe() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<Probe />, { wrapper });
}

beforeEach(() => {
  resetReportVendor();
  db.vendors = [];
});

describe('report vendor filter', () => {
  it('is absent with one active vendor, and a stale choice does not apply', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'inactive' },
    ];
    renderProbe();
    screen.getByText('pick').click();
    await waitFor(() => expect(screen.getByTestId('show').textContent).toBe('false'));
    expect(screen.getByTestId('vendor').textContent).toBe('');
    expect(screen.queryByText('Vendor')).toBeNull();
  });

  it('appears with two active vendors and applies the choice', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'active' },
    ];
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('show').textContent).toBe('true'));
    expect(screen.getByText('Vendor')).toBeTruthy();
    screen.getByText('pick').click();
    await waitFor(() => expect(screen.getByTestId('vendor').textContent).toBe('v-two'));
  });
});

describe('what a report filters by', () => {
  it('applies a chosen vendor while 2+ vendors are active', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'active' },
    ];
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('show').textContent).toBe('true'));
    screen.getByText('pick').click();
    render(<LoaderProbe />);
    await waitFor(() => expect(screen.getByTestId('applied').textContent).toBe('v-two'));
  });

  it('never applies a choice once only one vendor is left', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'active' },
    ];
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('show').textContent).toBe('true'));
    screen.getByText('pick').click();
    // The second vendor is switched off; the cached list expires.
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'inactive' },
    ];
    resetReportVendor({ keepChoice: true });
    expect(sessionStorage.getItem('sara.reports.vendor')).toBe('v-two');
    render(<LoaderProbe />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('applied').textContent).toBe('(all)');
  });

  it('is every vendor when nothing is chosen, without reading the vendor list', () => {
    render(<LoaderProbe />);
    expect(screen.getByTestId('applied').textContent).toBe('(all)');
  });
});

describe('withVendor', () => {
  it('leaves the filter untouched with no vendor', () => {
    const f = { date_created: { _gte: 'x' } };
    expect(withVendor(f, '')).toBe(f);
  });
  it('ANDs the vendor onto a filter, at the given path', () => {
    expect(withVendor({ a: 1 }, 'v1')).toEqual({ _and: [{ a: 1 }, { vendor: { _eq: 'v1' } }] });
    expect(withVendor({}, 'v1', ['conversation', 'vendor'])).toEqual({
      _and: [{ conversation: { vendor: { _eq: 'v1' } } }],
    });
  });
});
