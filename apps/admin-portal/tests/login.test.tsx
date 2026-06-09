import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, useNavigate: () => navigate };
});

const authState = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../src/lib/auth/AuthContext.js', () => ({
  useAuth: () => authState,
  isAdmin: (u: { role?: { name: string } } | null) => u?.role?.name === 'Administrator',
}));

import { Login } from '../src/pages/Login.js';

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

async function fillCredentials() {
  await userEvent.type(document.getElementById('email') as HTMLInputElement, 'a@b.com');
  await userEvent.type(document.getElementById('password') as HTMLInputElement, 'secret');
}

beforeEach(() => {
  authState.login.mockReset();
  authState.logout.mockReset();
  navigate.mockReset();
});

describe('Login', () => {
  it('renders the sign-in form', () => {
    renderLogin();
    expect(screen.getByText('Sign in to YIJI CRM Admin')).toBeInTheDocument();
    expect(screen.getByText('login.submit')).toBeInTheDocument();
  });

  it('navigates home after an admin logs in', async () => {
    authState.login.mockResolvedValueOnce({ role: { name: 'Administrator' } });
    renderLogin();
    await fillCredentials();
    await userEvent.click(screen.getByText('login.submit'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });

  it('rejects a non-admin and shows an error', async () => {
    authState.login.mockResolvedValueOnce({ role: { name: 'Agent' } });
    authState.logout.mockResolvedValueOnce(undefined);
    renderLogin();
    await fillCredentials();
    await userEvent.click(screen.getByText('login.submit'));
    await waitFor(() => expect(authState.logout).toHaveBeenCalled());
    expect(screen.getByText('login.notAdmin')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows a generic error when login throws', async () => {
    authState.login.mockRejectedValueOnce(new Error('bad creds'));
    renderLogin();
    await fillCredentials();
    await userEvent.click(screen.getByText('login.submit'));
    await waitFor(() => expect(screen.getByText('login.error')).toBeInTheDocument());
  });

  it('toggles password visibility', async () => {
    renderLogin();
    const pw = document.getElementById('password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    await userEvent.click(screen.getByLabelText('Reveal'));
    expect(pw.type).toBe('text');
  });
});
