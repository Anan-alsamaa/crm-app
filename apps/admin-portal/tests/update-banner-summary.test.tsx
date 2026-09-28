import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/*
 * THE UPDATE NOW STRIP'S ONE-LINE SUMMARY.
 *
 * Pinned here because the half that produces it CANNOT RUN ON STAGING: the
 * `pending/release.json` write lives inside `if [ "$GATED" = "1" ]`, and
 * staging is never gated, so nothing about this feature is exercised by a
 * staging deploy. Without these tests the first proof it works either way
 * would be a production release — and the failure mode is a silently EMPTY
 * line, which looks exactly like a release nobody bothered to describe.
 */

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

const producer = vi.hoisted(() => ({
  listReleases: vi.fn(),
  applyRelease: vi.fn(),
}));
vi.mock('../src/lib/job-producer.js', () => ({
  jobProducer: {
    listReleases: producer.listReleases,
    applyRelease: producer.applyRelease,
  },
}));

const auth = vi.hoisted(() => ({
  user: { admin_access: true } as { admin_access: boolean } | null,
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => ({ user: auth.user }),
}));

import { UpdateBanner } from '../src/features/releases/UpdateBanner.js';

const build = (over: Record<string, unknown> = {}) => ({
  version: 'v1.19.0',
  commit: 'abc1234',
  publishedAt: '2026-09-28T09:00:00Z',
  app: 'agent portal',
  bundle: '/assets/index-x.js',
  ...over,
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { admin_access: true };
});

describe('Update now strip — what the release changes', () => {
  it('shows the summary when the release carries one', async () => {
    const line = 'the Update now strip says what the release changes';
    producer.listReleases.mockResolvedValue({
      ok: true,
      pending: [build({ summary: line })],
      live: null,
    });

    render(<UpdateBanner />, { wrapper: wrap() });

    expect(await screen.findByText(line)).toBeTruthy();
    // The strip still says WHO, so the summary is an addition, not a swap.
    expect(screen.getByText(/An update is waiting for the agent portal/)).toBeTruthy();
  });

  /*
   * THE STAGING / OLD-BUILD CASE. An absent summary must leave the strip
   * reading exactly as it did before — no empty element, no stray separator.
   */
  it('renders the strip unchanged when there is no summary', async () => {
    producer.listReleases.mockResolvedValue({ ok: true, pending: [build()], live: null });

    render(<UpdateBanner />, { wrapper: wrap() });

    expect(await screen.findByText(/An update is waiting for the agent portal/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeTruthy();
    expect(screen.getByText(/v1\.19\.0 · nobody sees it until you apply it\./)).toBeTruthy();
  });

  /*
   * A summary of "" or "   " is the shape a BROKEN CI WRITE produces — the
   * exact bug that nearly shipped. It must be treated as absent, never
   * rendered as a blank gap.
   */
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats a %s summary as absent', async (_label, summary) => {
    producer.listReleases.mockResolvedValue({
      ok: true,
      pending: [build({ summary })],
      live: null,
    });

    const { container } = render(<UpdateBanner />, { wrapper: wrap() });

    await screen.findByText(/An update is waiting for the agent portal/);
    expect(container.querySelector('.line-clamp-1')).toBeNull();
  });

  /*
   * Every gated surface ships from ONE commit, so the entries carry the same
   * summary and it must appear ONCE — and a surface published before this
   * existed must not hide a sibling's line.
   */
  it('shows one summary for a multi-surface release', async () => {
    const line = 'late-order coupons and the inbox order heading';
    producer.listReleases.mockResolvedValue({
      ok: true,
      pending: [
        build({ app: 'agent portal' }), // no summary
        build({ app: 'chat widget', summary: line }),
      ],
      live: null,
    });

    render(<UpdateBanner />, { wrapper: wrap() });

    expect(await screen.findAllByText(line)).toHaveLength(1);
    expect(screen.getByText(/agent portal \+ chat widget/)).toBeTruthy();
  });

  it('carries the whole sentence in a title, so clamping never loses it', async () => {
    const line =
      'a very long release subject that would wrap onto a second line and push the button out of reach';
    producer.listReleases.mockResolvedValue({
      ok: true,
      pending: [build({ summary: line })],
      live: null,
    });

    const { container } = render(<UpdateBanner />, { wrapper: wrap() });

    await screen.findByText(line);
    const el = container.querySelector('.line-clamp-1');
    expect(el?.getAttribute('title')).toBe(line);
  });

  // The strip is an administrator's control; a summary must not leak past it.
  it('shows nothing at all to a non-administrator', async () => {
    auth.user = { admin_access: false };
    producer.listReleases.mockResolvedValue({
      ok: true,
      pending: [build({ summary: 'secret' })],
      live: null,
    });

    const { container } = render(<UpdateBanner />, { wrapper: wrap() });

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(producer.listReleases).not.toHaveBeenCalled();
  });
});
