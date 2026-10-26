import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * The admin portal's "What's new" tour (owner, 2026-10-25): the Administrator
 * and WeCare Supervisor / WeCare Admin, NOT WeCare Agent; "seen" per portal;
 * Esc counts as seen; reopened from the Aura panel.
 */

const i18nState = vi.hoisted(() => ({ language: 'en' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let out = (opts?.defaultValue as string | undefined) ?? key;
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (k === 'defaultValue') continue;
        out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      }
      return out;
    },
    i18n: i18nState,
  }),
}));

const authState = vi.hoisted(() => ({
  user: { id: 'u1', role: { id: 'r1', name: 'Administrator' } } as {
    id: string;
    role: { id: string; name: string } | null;
  },
  isOwner: true,
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => authState,
}));

const ai = vi.hoisted(() => ({ helpAssistant: vi.fn() }));
vi.mock('../src/lib/ai-client.js', () => ({ ai }));

import { AdminWhatsNew } from '../src/features/whats-new/WhatsNew.js';
import { HelpAssistant } from '../src/features/help-assistant/HelpAssistant.js';
import {
  ADMIN_PORTAL_WHATS_NEW,
  WHATS_NEW_VERSION,
  adminPortalAudience,
} from '../src/features/whats-new/notes.js';

const KEY = 'sara.whatsNew.admin.u1';

function setRole(name: string | null, isOwner = false) {
  authState.user = { id: 'u1', role: name ? { id: 'r1', name } : null };
  authState.isOwner = isOwner;
}

function renderTour(children: ReactNode = null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AdminWhatsNew>{children}</AdminWhatsNew>
    </QueryClientProvider>,
  );
}

async function settle(ms = 750) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  localStorage.clear();
  setRole('Administrator', true);
  i18nState.language = 'en';
});

describe('who sees it in the admin portal', () => {
  it('the Administrator is the owner; WeCare Supervisor and WeCare Admin are supervisors', () => {
    expect(adminPortalAudience('Administrator', true)).toBe('owner');
    expect(adminPortalAudience('WeCare Supervisor', false)).toBe('supervisor');
    expect(adminPortalAudience(' wecare  admin', false)).toBe('supervisor');
  });

  it('WeCare Agent, and everybody else, gets nothing here', () => {
    for (const name of ['WeCare Agent', 'Agent', 'Admin', 'CEO', 'TV Screen', '', null]) {
      expect(adminPortalAudience(name, false)).toBeNull();
    }
  });

  it('has notes for both audiences in both languages', () => {
    expect(ADMIN_PORTAL_WHATS_NEW.version).toBe(WHATS_NEW_VERSION);
    for (const a of ['supervisor', 'owner'] as const) {
      const entry = ADMIN_PORTAL_WHATS_NEW.audiences[a]!;
      expect(entry.en.slides.length).toBeGreaterThan(0);
      expect(entry.ar.slides.length).toBe(entry.en.slides.length);
      entry.en.slides.forEach((slide, i) => {
        expect(slide.art).toBeTruthy();
        expect(entry.ar.slides[i]!.art).toBe(slide.art);
      });
      expect(entry.en.outro?.title).toBeTruthy();
      expect(entry.ar.outro?.title).toBeTruthy();
    }
  });

  it('ends on the thank-you step with Let’s go', async () => {
    renderTour();
    await settle();
    await screen.findByRole('dialog');
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Your console is ready' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Let’s go' }));
    expect(localStorage.getItem(KEY)).toBe(WHATS_NEW_VERSION);
  });

  it('shows the Administrator the console tour', async () => {
    renderTour();
    await settle();
    expect(
      await screen.findByRole('heading', { name: 'Your console, redesigned' }),
    ).toBeInTheDocument();
  });

  it('shows a WeCare Supervisor the admin-portal changes that concern them', async () => {
    setRole('WeCare Supervisor');
    renderTour();
    await settle();
    expect(
      await screen.findByRole('heading', { name: 'Reports that read faster' }),
    ).toBeInTheDocument();
  });

  it('shows a WeCare Agent nothing', async () => {
    setRole('WeCare Agent');
    renderTour();
    await settle(900);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('memory and reopening', () => {
  it('Escape counts as seen, for this portal only', async () => {
    localStorage.setItem('sara.whatsNew.agent.u1', WHATS_NEW_VERSION);
    const view = renderTour();
    await settle();
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(localStorage.getItem(KEY)).toBe(WHATS_NEW_VERSION);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.unmount();
    renderTour();
    await settle(900);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reopens from the Aura panel', async () => {
    localStorage.setItem(KEY, WHATS_NEW_VERSION);
    renderTour(<HelpAssistant />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI help' }));
    fireEvent.click(await screen.findByRole('button', { name: 'What’s new' }));
    expect(
      await screen.findByRole('dialog', { name: 'Your console, redesigned' }),
    ).toBeInTheDocument();
  });
});
