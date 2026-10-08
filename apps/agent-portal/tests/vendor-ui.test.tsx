import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * MV-4 (EMA-73): the SAME agents serve every vendor, so with 2+ vendors live a
 * chat, ticket or coupon names its vendor and lists can be narrowed by it.
 * With ONE vendor (today) none of that renders — it would only ever name the
 * one possible answer.
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

import { useVendorDirectory, VendorBadge } from '../src/lib/vendors.js';
import { buildFilter } from '../src/features/inbox/api.js';
import { repliesForVendor, type QuickReply } from '../src/features/conversation/QuickReplies.js';

function Probe({ vendor }: { vendor: string | null }) {
  const dir = useVendorDirectory();
  return (
    <div>
      <span data-testid="show">{String(dir.show)}</span>
      <VendorBadge vendor={vendor} directory={dir} />
    </div>
  );
}

function renderProbe(vendor: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<Probe vendor={vendor} />, { wrapper });
}

beforeEach(() => {
  db.vendors = [];
});

describe('vendor badge visibility', () => {
  it('renders NOTHING with a single active vendor', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-old', name: 'Old', status: 'inactive' },
    ];
    renderProbe('v-yiji');
    await waitFor(() => expect(screen.getByTestId('show').textContent).toBe('false'));
    expect(screen.queryByTestId('vendor-badge')).toBeNull();
  });

  it("names the record's vendor once two vendors are active", async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'active' },
    ];
    renderProbe('v-two');
    await waitFor(() => expect(screen.getByTestId('vendor-badge').textContent).toBe('Second'));
  });

  it('shows no badge for a record whose vendor is unknown', async () => {
    db.vendors = [
      { id: 'v-yiji', name: 'Yiji', status: 'active' },
      { id: 'v-two', name: 'Second', status: 'active' },
    ];
    renderProbe(null);
    await waitFor(() => expect(screen.getByTestId('show').textContent).toBe('true'));
    expect(screen.queryByTestId('vendor-badge')).toBeNull();
  });
});

describe('inbox vendor filter', () => {
  it('narrows to one vendor when chosen, and adds nothing when not', () => {
    const on = JSON.stringify(buildFilter({ vendor: 'v-two' }));
    expect(on).toContain('"vendor":{"_eq":"v-two"}');
    expect(JSON.stringify(buildFilter({}))).not.toContain('vendor');
  });
});

describe('quick replies per vendor', () => {
  const rows: QuickReply[] = [
    { id: 'shared', label: 'Hi', text: 'Hi', lang: 'en', vendor: null },
    { id: 'mine', label: 'Mine', text: 'Mine', lang: 'en', vendor: 'v-1' },
    { id: 'theirs', label: 'Theirs', text: 'Theirs', lang: 'en', vendor: { id: 'v-2' } },
  ];
  it("offers the shared replies plus this chat's vendor's, never another vendor's", () => {
    expect(repliesForVendor(rows, 'v-1').map((r) => r.id)).toEqual(['shared', 'mine']);
    expect(repliesForVendor(rows, 'v-2').map((r) => r.id)).toEqual(['shared', 'theirs']);
  });
  it('narrows nothing when the vendor is not known (one vendor: every reply)', () => {
    expect(repliesForVendor(rows, undefined)).toHaveLength(3);
  });
});
