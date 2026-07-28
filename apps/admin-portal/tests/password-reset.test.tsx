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
  logout: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => auth,
  isAdmin: () => true,
}));

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
  auth.logout.mockReset();
  auth.requestPasswordReset.mockReset();
  auth.resetPassword.mockReset();
  auth.requestPasswordReset.mockResolvedValue(undefined);
  auth.resetPassword.mockResolvedValue(undefined);
});

describe('Admin login — forgot password (FR-001)', () => {
  it('sends the reset request and shows the neutral confirmation', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('Forgot password?'));
    await userEvent.type(
      document.getElementById('forgot-email') as HTMLInputElement,
      'admin@example.com',
    );
    await userEvent.click(screen.getByText('Send reset link'));

    await waitFor(() => expect(auth.requestPasswordReset).toHaveBeenCalledTimes(1));
    expect(auth.requestPasswordReset).toHaveBeenCalledWith(
      'admin@example.com',
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

    expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
  });
});

describe('Admin ResetPassword page (FR-001)', () => {
  it('rejects mismatched passwords without calling Directus', async () => {
    renderReset();
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.type(document.getElementById('confirm') as HTMLInputElement, 'CorrectHorse2');
    await userEvent.click(screen.getByText('Update password'));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
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

  it('surfaces an expired/invalid token', async () => {
    auth.resetPassword.mockRejectedValue(new Error('403'));
    renderReset();
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.type(document.getElementById('confirm') as HTMLInputElement, 'CorrectHorse1');
    await userEvent.click(screen.getByText('Update password'));

    expect(
      await screen.findByText('This reset link is invalid or has expired. Request a new one.'),
    ).toBeInTheDocument();
  });
});
