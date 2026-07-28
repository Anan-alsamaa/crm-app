import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => auth }));

import { Login } from '../src/pages/Login.js';
import { ResetPassword } from '../src/pages/ResetPassword.js';

const NEUTRAL =
  'If that email matches an account, we just sent a reset link. It expires shortly — check your spam folder if it does not arrive.';

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

function renderReset(search = '?token=tok-123') {
  return render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/login" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.login.mockReset();
  auth.requestPasswordReset.mockReset();
  auth.resetPassword.mockReset();
  auth.requestPasswordReset.mockResolvedValue(undefined);
  auth.resetPassword.mockResolvedValue(undefined);
});

describe('Login — forgot password (FR-001)', () => {
  it('sends the reset request and shows the neutral confirmation', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('Forgot password?'));
    await userEvent.type(
      document.getElementById('forgot-email') as HTMLInputElement,
      'agent@example.com',
    );
    await userEvent.click(screen.getByText('Send reset link'));

    await waitFor(() => expect(auth.requestPasswordReset).toHaveBeenCalledTimes(1));
    // Directus is told where the completion page lives (must be allow-listed
    // server-side via PASSWORD_RESET_URL_ALLOW_LIST).
    expect(auth.requestPasswordReset).toHaveBeenCalledWith(
      'agent@example.com',
      `${window.location.origin}/reset-password`,
    );
    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
  });

  it('shows the SAME confirmation for an unknown address (no account enumeration)', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('Forgot password?'));
    await userEvent.type(
      document.getElementById('forgot-email') as HTMLInputElement,
      'nobody@example.com',
    );
    await userEvent.click(screen.getByText('Send reset link'));

    const first = await screen.findByText(NEUTRAL);
    expect(first).toBeInTheDocument();
    // Nothing on screen distinguishes a registered address from an unknown one.
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
  });

  it('does not call the request helper for an invalid email', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('Forgot password?'));
    await userEvent.type(
      document.getElementById('forgot-email') as HTMLInputElement,
      'not-an-email',
    );
    await userEvent.click(screen.getByText('Send reset link'));
    await waitFor(() => expect(auth.requestPasswordReset).not.toHaveBeenCalled());
  });
});

describe('ResetPassword page (FR-001)', () => {
  it('rejects mismatched passwords without calling Directus', async () => {
    renderReset();
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.type(document.getElementById('confirm') as HTMLInputElement, 'CorrectHorse2');
    await userEvent.click(screen.getByText('Update password'));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('rejects a too-short password', async () => {
    renderReset();
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'short');
    await userEvent.type(document.getElementById('confirm') as HTMLInputElement, 'short');
    await userEvent.click(screen.getByText('Update password'));

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('submits the token + new password and returns to sign in', async () => {
    renderReset();
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.type(document.getElementById('confirm') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.click(screen.getByText('Update password'));

    await waitFor(() =>
      expect(auth.resetPassword).toHaveBeenCalledWith('tok-123', 'CorrectHorse1'),
    );
    expect(await screen.findByText('login-page')).toBeInTheDocument();
  });

  it('surfaces an expired/invalid token instead of silently failing', async () => {
    auth.resetPassword.mockRejectedValue(new Error('403'));
    renderReset();
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.type(document.getElementById('confirm') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.click(screen.getByText('Update password'));

    expect(
      await screen.findByText('This reset link is invalid or has expired. Request a new one.'),
    ).toBeInTheDocument();
  });

  it('explains a link with no token at all', () => {
    renderReset('');
    expect(
      screen.getByText('This reset link is incomplete. Request a new one from sign in.'),
    ).toBeInTheDocument();
  });
});
