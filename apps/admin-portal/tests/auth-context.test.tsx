import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import React from 'react';

const authMock = vi.hoisted(() => ({
  me: vi.fn(),
  restore: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../src/lib/directus.js', () => ({ auth: authMock }));

import { AuthProvider, useAuth, isAdmin } from '../src/lib/auth/AuthContext.js';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  authMock.me.mockReset();
  authMock.restore.mockReset();
  authMock.login.mockReset();
  authMock.logout.mockReset();
});

describe('isAdmin', () => {
  it('accepts Administrator and Admin roles', () => {
    expect(isAdmin({ role: { name: 'Administrator' } } as never)).toBe(true);
    expect(isAdmin({ role: { name: 'Admin' } } as never)).toBe(true);
  });
  it('rejects other roles and null', () => {
    expect(isAdmin({ role: { name: 'Agent' } } as never)).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});

describe('useAuth outside provider', () => {
  it('throws a helpful error', () => {
    expect(() => renderHook(() => useAuth())).toThrow(/AuthProvider/);
  });
});

function Probe() {
  const { user, loading, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <button onClick={() => void login('a@b.com', 'pw')}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('loads the current user on mount', async () => {
    authMock.restore.mockResolvedValue({ id: '1', email: 'me@x.com' });
    render(<Probe />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('user').textContent).toBe('me@x.com');
  });

  it('login then logout updates the user', async () => {
    authMock.restore.mockResolvedValue(null); // cold load: no session
    authMock.me.mockResolvedValue({ id: '1', email: 'me@x.com' }); // login() loads the user
    authMock.login.mockResolvedValue(undefined);
    authMock.logout.mockResolvedValue(undefined);
    render(<Probe />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('me@x.com'));
    expect(authMock.login).toHaveBeenCalledWith('a@b.com', 'pw');

    await userEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('none'));
  });
});
