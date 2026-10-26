import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * The agent portal's "What's new" tour (owner, 2026-10-25): who sees it, once
 * per version, Esc counts as seen, reopening from the help panel, waiting for
 * another modal, and the reduced-motion path.
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
  user: { id: 'u1', role: { id: 'r1', name: 'WeCare Agent' } } as {
    id: string;
    role: { id: string; name: string } | null;
  },
  isOwner: false,
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => authState,
}));

const ai = vi.hoisted(() => ({ helpAssistant: vi.fn() }));
vi.mock('../src/lib/ai-client.js', () => ({ ai }));

import { useWhatsNew } from '@yiji/ui';
import { AgentWhatsNew } from '../src/features/whats-new/WhatsNew.js';
import { HelpAssistant } from '../src/features/help-assistant/HelpAssistant.js';
import {
  AGENT_PORTAL_WHATS_NEW,
  WHATS_NEW_VERSION,
  agentPortalAudience,
} from '../src/features/whats-new/notes.js';

const KEY = 'sara.whatsNew.agent.u1';

function setRole(name: string | null, isOwner = false) {
  authState.user = { id: 'u1', role: name ? { id: 'r1', name } : null };
  authState.isOwner = isOwner;
}

function mockReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderTour(children: ReactNode = null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AgentWhatsNew>{children}</AgentWhatsNew>
    </QueryClientProvider>,
  );
}

/** Wait past the 600ms settle delay. */
async function settle(ms = 750) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

beforeEach(() => {
  localStorage.clear();
  setRole('WeCare Agent');
  i18nState.language = 'en';
  mockReducedMotion(false);
});

afterEach(() => {
  document.querySelectorAll('[data-test-modal]').forEach((n) => n.remove());
});

describe('who sees it in the agent portal', () => {
  it('maps the three WeCare roles and the Administrator, case- and space-insensitively', () => {
    expect(agentPortalAudience('WeCare Agent', false)).toBe('agent');
    expect(agentPortalAudience('  wecare   agent ', false)).toBe('agent');
    expect(agentPortalAudience('WeCare Supervisor', false)).toBe('supervisor');
    expect(agentPortalAudience('WECARE ADMIN', false)).toBe('supervisor');
    expect(agentPortalAudience('Administrator', true)).toBe('owner');
    expect(agentPortalAudience(null, true)).toBe('owner');
  });

  it('gives everybody else nothing', () => {
    for (const name of [
      'Agent',
      'Admin',
      'TV Screen',
      'CEO',
      'WeCare',
      'WeCare Agents',
      '',
      null,
    ]) {
      expect(agentPortalAudience(name, false)).toBeNull();
    }
  });

  it('has notes for every audience in both languages, for the current version', () => {
    expect(AGENT_PORTAL_WHATS_NEW.version).toBe(WHATS_NEW_VERSION);
    for (const a of ['agent', 'supervisor', 'owner'] as const) {
      const entry = AGENT_PORTAL_WHATS_NEW.audiences[a]!;
      expect(entry.en.slides.length).toBeGreaterThan(0);
      expect(entry.ar.slides.length).toBe(entry.en.slides.length);
      // Every slide has its picture, the same one in both languages, and
      // both languages end on the thank-you step.
      entry.en.slides.forEach((slide, i) => {
        expect(slide.art).toBeTruthy();
        expect(entry.ar.slides[i]!.art).toBe(slide.art);
      });
      expect(entry.en.outro?.title).toBeTruthy();
      expect(entry.ar.outro?.title).toBeTruthy();
    }
  });

  it('shows a WeCare Agent the agent tour after the shell settles, not at once', async () => {
    renderTour();
    expect(screen.queryByRole('dialog')).toBeNull();
    await settle();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'A fresh Sara CRM' })).toBeInTheDocument();
    expect(screen.getByText('New in v1.2.1')).toBeInTheDocument();
    expect(screen.getAllByText('1 of 5').length).toBeGreaterThan(0);
  });

  it('shows a WeCare Supervisor and a WeCare Admin the supervisor tour', async () => {
    setRole('WeCare Admin');
    renderTour();
    await settle();
    expect(
      await screen.findByRole('heading', { name: 'More control, less hunting' }),
    ).toBeInTheDocument();
  });

  it('shows the Administrator the agent-portal changes', async () => {
    setRole('Administrator', true);
    renderTour();
    await settle();
    expect(
      await screen.findByRole('heading', { name: 'The agent portal, refreshed' }),
    ).toBeInTheDocument();
  });

  it('shows nothing, and offers no menu entry, to any other role', async () => {
    setRole('TV Screen');
    function Probe() {
      const w = useWhatsNew();
      return <span data-testid="probe">{String(w?.available)}</span>;
    }
    renderTour(<Probe />);
    await settle(900);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });
});

describe('once per user per version', () => {
  it('walks the slides to the finale, Let’s go remembers the version, and it does not come back', async () => {
    const view = renderTour();
    await settle();
    await screen.findByRole('dialog');
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getAllByText('5 of 5').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'You are all set' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Let’s go' }));
    expect(localStorage.getItem(KEY)).toBe('1.2.1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    view.unmount();
    renderTour();
    await settle(900);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows again when the remembered version is an older one', async () => {
    localStorage.setItem(KEY, '1.0.0');
    renderTour();
    await settle();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('remembers per portal: seeing the admin tour does not hide this one', async () => {
    localStorage.setItem('sara.whatsNew.admin.u1', WHATS_NEW_VERSION);
    renderTour();
    await settle();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('the arrow keys walk the tour, mirrored in Arabic', async () => {
    const view = renderTour();
    await settle();
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getAllByText('3 of 5').length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getAllByText('2 of 5').length).toBeGreaterThan(0);
    // Not past either end.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getAllByText('1 of 5').length).toBeGreaterThan(0);
    view.unmount();

    localStorage.clear();
    i18nState.language = 'ar';
    renderTour();
    await settle();
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getAllByText('2 of 5').length).toBeGreaterThan(0);
  });

  it('Escape closes it and counts as seen', async () => {
    renderTour();
    await settle();
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(localStorage.getItem(KEY)).toBe('1.2.1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('waits while another modal is open, then appears', async () => {
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('aria-modal', 'true');
    other.setAttribute('data-test-modal', '');
    document.body.appendChild(other);
    renderTour();
    await settle(900);
    expect(document.querySelector('[data-whats-new]')).toBeNull();
    other.remove();
    await settle(1100);
    expect(document.querySelector('[data-whats-new]')).not.toBeNull();
  });
});

describe('reopening from the help panel', () => {
  it('the Aura panel offers What’s new and reopens the tour after it was seen', async () => {
    localStorage.setItem(KEY, WHATS_NEW_VERSION);
    renderTour(<HelpAssistant />);
    await settle(900);
    expect(screen.queryByRole('dialog')).toBeNull();

    const launcher = screen.getByRole('button', { name: 'Ask AI help' });
    launcher.focus();
    fireEvent.click(launcher);
    fireEvent.click(await screen.findByRole('button', { name: 'What’s new' }));

    const dialog = await screen.findByRole('dialog', { name: 'A fresh Sara CRM' });
    expect(dialog).toHaveAttribute('data-whats-new');
    // The Aura drawer made way for it.
    expect(screen.queryByPlaceholderText('Ask Aura anything…')).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus goes back to where the person was.
    await waitFor(() => expect(document.activeElement).toBe(launcher));
  });

  it('the empty state offers the tour too, as a card under the starters', async () => {
    localStorage.setItem(KEY, WHATS_NEW_VERSION);
    renderTour(<HelpAssistant />);
    await settle(900);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI help' }));
    // Both ways in: the header pill and the card.
    expect(await screen.findByRole('button', { name: 'What’s new' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New in this release/ }));
    expect(await screen.findByRole('dialog', { name: 'A fresh Sara CRM' })).toBeInTheDocument();
  });

  it('a role with no tour gets no entry in the panel', async () => {
    setRole('CEO');
    renderTour(<HelpAssistant />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI help' }));
    await screen.findByPlaceholderText('Ask Aura anything…');
    expect(screen.queryByRole('button', { name: 'What’s new' })).toBeNull();
    expect(screen.queryByRole('button', { name: /New in this release/ })).toBeNull();
  });
});

describe('motion and language', () => {
  it('reduced motion: no animation classes and no cross-slide copy', async () => {
    mockReducedMotion(true);
    renderTour();
    await settle();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-motion', 'reduce');
    expect(dialog.innerHTML).not.toMatch(/animate-wn-/);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(dialog.querySelectorAll('[data-slide-index]')).toHaveLength(1);
    expect(dialog.querySelector('[aria-hidden="true"] h3')).toBeNull();
    // Closing is immediate: nothing waits on an exit animation.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('full motion: the slide crosses, keeping the leaving slide for a moment', async () => {
    renderTour();
    await settle();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-motion', 'full');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(dialog.innerHTML).toMatch(/animate-wn-slide-out/);
    expect(dialog.querySelector('[data-slide-index="1"]')).not.toBeNull();
  });

  it('Arabic: right-to-left with the Arabic notes', async () => {
    i18nState.language = 'ar';
    renderTour();
    await settle();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { name: 'Sara CRM بحلّة جديدة' })).toBeInTheDocument();
  });
});
