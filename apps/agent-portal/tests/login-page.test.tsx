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

const auth = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../src/lib/auth/AuthContext.js', () => ({ useAuth: () => auth }));

import { Login } from '../src/pages/Login.js';

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

beforeEach(() => auth.login.mockReset());

describe('Login page', () => {
  it('renders the sign-in form', () => {
    renderLogin();
    expect(screen.getByText('Sign in to YIJI CRM')).toBeInTheDocument();
    expect(screen.getByText('login.submit')).toBeInTheDocument();
  });

  it('toggles password visibility', async () => {
    renderLogin();
    const pw = document.getElementById('password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    await userEvent.click(screen.getByLabelText('Reveal'));
    expect(pw.type).toBe('text');
  });

  it('calls login with the submitted credentials', async () => {
    auth.login.mockResolvedValue(undefined);
    renderLogin();
    await userEvent.type(document.getElementById('email') as HTMLInputElement, 'a@b.com');
    await userEvent.type(document.getElementById('password') as HTMLInputElement, 'secret');
    await userEvent.click(screen.getByText('login.submit'));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('a@b.com', 'secret'));
  });

  it('does not call login when the form is empty (client validation blocks it)', async () => {
    renderLogin();
    await userEvent.click(screen.getByText('login.submit'));
    // Zod validation fails, so login is never attempted.
    expect(auth.login).not.toHaveBeenCalled();
  });
});
