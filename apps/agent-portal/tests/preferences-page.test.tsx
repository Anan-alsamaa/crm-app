import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

const hooks = vi.hoisted(() => ({
  useNotificationPreferences: vi.fn(),
  useUpdateNotificationPreferences: vi.fn(),
  useOrgNotificationDefaults: vi.fn(),
  useUpdateOrgNotificationDefaults: vi.fn(),
  /* The REAL precedence rule, not a stub: these tests are about what the page
     shows, and a fake that always returned the agent's own value would let a
     broken override pass. */
  resolvePreferences: (
    mine: Record<string, string> | null | undefined,
    org: Record<string, string> | null | undefined,
  ) => ({ ...(mine ?? {}), ...(org ?? {}) }),
  // Real channel list mirrored so the Select options render.
  CHANNELS: ['in_app', 'email', 'both', 'none'],
}));
vi.mock('../src/features/notifications/api.js', () => hooks);

/* Who is signed in. `admin_access` is what decides whether the page offers to
   edit everybody's settings, so it is the knob these tests turn. */
const auth = vi.hoisted(() => ({
  user: { id: 'u1', admin_access: false } as Record<string, unknown>,
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => auth }));

import { PreferencesPage } from '../src/features/notifications/PreferencesPage.js';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<PreferencesPage />, { wrapper: Wrapper });
}

const saveOrg = vi.fn();

beforeEach(() => {
  hooks.useNotificationPreferences.mockReset();
  hooks.useUpdateNotificationPreferences.mockReset();
  hooks.useOrgNotificationDefaults.mockReset();
  hooks.useUpdateOrgNotificationDefaults.mockReset();
  saveOrg.mockReset().mockResolvedValue({});
  auth.user = { id: 'u1', admin_access: false };
  hooks.useUpdateNotificationPreferences.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  // No organisation policy is the ordinary state.
  hooks.useOrgNotificationDefaults.mockReturnValue({ data: {}, isLoading: false });
  hooks.useUpdateOrgNotificationDefaults.mockReturnValue({
    mutateAsync: saveOrg,
    isPending: false,
  });
});

describe('PreferencesPage', () => {
  it('shows a spinner while preferences load', () => {
    hooks.useNotificationPreferences.mockReturnValue({ data: undefined, isLoading: true });
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders preference groups with channel selects', () => {
    hooks.useNotificationPreferences.mockReturnValue({
      data: { sla_warning: 'email', assignment: 'both', mention: 'none', automation: 'in_app' },
      isLoading: false,
    });
    renderPage();
    expect(screen.getByText('SLA')).toBeInTheDocument();
    expect(screen.getByText('Tickets')).toBeInTheDocument();
    // Each notification type renders a labelled select.
    expect(screen.getByLabelText('sla_warning')).toBeInTheDocument();
    expect(screen.getByLabelText('assignment')).toBeInTheDocument();
  });

  it('saves the draft when Save is clicked', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useUpdateNotificationPreferences.mockReturnValue({ mutateAsync, isPending: false });
    hooks.useNotificationPreferences.mockReturnValue({
      data: { sla_warning: 'email' },
      isLoading: false,
    });
    renderPage();
    await userEvent.click(screen.getByText('actions.save'));
    expect(mutateAsync).toHaveBeenCalled();
  });
});

/*
 * AN ADMINISTRATOR CAN SET THE ORGANISATION'S POLICY FROM THIS SAME PAGE
 * (owner, 2026-09-16). Both can set; where they disagree the administrator
 * wins, and the agent's own choice is kept rather than overwritten.
 *
 * The risk this guards is specific: the two halves of the page look identical,
 * so an administrator could change everybody's settings believing they had
 * changed their own. Hence a visible switch, and a default of "mine".
 */
describe('PreferencesPage — the organisation policy', () => {
  const asAdmin = () => {
    auth.user = { id: 'u1', admin_access: true };
  };

  it('offers no organisation switch to an ordinary agent', () => {
    hooks.useNotificationPreferences.mockReturnValue({
      data: { assignment: 'both' },
      isLoading: false,
    });
    renderPage();
    expect(screen.queryByText('Everyone')).toBeNull();
  });

  it('offers the switch to an administrator, and STARTS on their own settings', () => {
    asAdmin();
    hooks.useNotificationPreferences.mockReturnValue({
      data: { assignment: 'both' },
      isLoading: false,
    });
    renderPage();
    const mine = screen.getByRole('button', { name: 'My notifications' });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Everyone' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('writes the POLICY, not the admin’s own row, when editing everyone', async () => {
    asAdmin();
    const mutateAsync = vi.fn().mockResolvedValue({});
    hooks.useUpdateNotificationPreferences.mockReturnValue({ mutateAsync, isPending: false });
    hooks.useNotificationPreferences.mockReturnValue({
      data: { assignment: 'both' },
      isLoading: false,
    });
    hooks.useOrgNotificationDefaults.mockReturnValue({
      data: { sla_breach: 'both' },
      isLoading: false,
    });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    await userEvent.click(screen.getByText('actions.save'));

    expect(saveOrg).toHaveBeenCalledWith({ sla_breach: 'both' });
    // The administrator's personal preferences are untouched by a policy save.
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('tells an agent when a setting is not theirs to change, and locks it', () => {
    hooks.useNotificationPreferences.mockReturnValue({
      data: { sla_breach: 'none' },
      isLoading: false,
    });
    hooks.useOrgNotificationDefaults.mockReturnValue({
      data: { sla_breach: 'both' },
      isLoading: false,
    });
    renderPage();

    // Said out loud rather than silently ignored: a control that accepts a
    // choice and then overrules it is worse than one plainly not theirs.
    expect(screen.getByText('Set for everyone by an administrator')).toBeInTheDocument();
    expect(screen.getByLabelText('sla_breach')).toBeDisabled();
  });

  it('leaves un-dictated types to the agent', () => {
    hooks.useNotificationPreferences.mockReturnValue({
      data: { sla_breach: 'none', assignment: 'email' },
      isLoading: false,
    });
    hooks.useOrgNotificationDefaults.mockReturnValue({
      data: { sla_breach: 'both' },
      isLoading: false,
    });
    renderPage();
    // A policy on ONE notification is not a policy on all of them.
    expect(screen.getByLabelText('assignment')).not.toBeDisabled();
  });
});
