import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const { authMock, disconnectSocket, setSessionExpiredHandler } = vi.hoisted(() => ({
  authMock: { me: vi.fn(), restore: vi.fn(), login: vi.fn(), logout: vi.fn() },
  disconnectSocket: vi.fn(),
  setSessionExpiredHandler: vi.fn(),
}));
vi.mock('../src/lib/directus.js', () => ({ auth: authMock }));
vi.mock('../src/lib/socket.js', () => ({ disconnectSocket, setSessionExpiredHandler }));
vi.mock('react-i18next', () => {
  // Stable `t` reference so the provider's [t] effect doesn't re-run each render.
  const t = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;
  return { useTranslation: () => ({ t }) };
});
// Replace just the toast helper (no Toaster is mounted in this unit test).
vi.mock('@yiji/ui', async (orig) => {
  const actual = await orig<typeof import('@yiji/ui')>();
  return { ...actual, toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } };
});

import { AuthProvider, useAuth } from '../src/lib/auth/AuthContext.js';

function Consumer() {
  const { user, loading, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? `user:${user.email}` : 'anon'}</span>
      <button onClick={() => void login('a@b.com', 'pw')}>do-login</button>
      <button onClick={() => void logout()}>do-logout</button>
    </div>
  );
}

const me = { id: '1', email: 'agent@x.com', first_name: null, last_name: null, status: 'active' };

beforeEach(() => {
  authMock.me.mockReset();
  authMock.restore.mockReset();
  authMock.login.mockReset();
  authMock.logout.mockReset();
  disconnectSocket.mockReset();
  setSessionExpiredHandler.mockReset();
});

describe('AuthProvider / useAuth', () => {
  it('restores the session on mount', async () => {
    authMock.restore.mockResolvedValue(me);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:agent@x.com'));
  });

  it('shows anon when no session is restored', async () => {
    authMock.restore.mockResolvedValue(null);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anon'));
  });

  it('login authenticates and loads the user', async () => {
    authMock.restore.mockResolvedValue(null); // cold load: no session
    authMock.me.mockResolvedValue(me); // login() then loads the user
    authMock.login.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anon'));
    await userEvent.click(screen.getByText('do-login'));
    expect(authMock.login).toHaveBeenCalledWith('a@b.com', 'pw');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:agent@x.com'));
  });

  it('logout drops the socket then revokes the token', async () => {
    authMock.restore.mockResolvedValue(me);
    authMock.logout.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:agent@x.com'));
    await userEvent.click(screen.getByText('do-logout'));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anon'));
    expect(disconnectSocket).toHaveBeenCalled();
    expect(authMock.logout).toHaveBeenCalled();
  });

  it('clears the session when the gateway reports the token expired', async () => {
    authMock.restore.mockResolvedValue(me);
    authMock.logout.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:agent@x.com'));

    // The provider registers a session-expired handler; invoke it the way the
    // socket layer would when the gateway rejects our token.
    const handler = setSessionExpiredHandler.mock.calls
      .map((c) => c[0])
      .find((arg): arg is () => void => typeof arg === 'function');
    expect(handler).toBeTruthy();
    await act(async () => {
      handler!();
    });

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anon'));
    expect(authMock.logout).toHaveBeenCalled();
  });

  it('useAuth throws when used outside the provider', () => {
    const Bare = () => {
      useAuth();
      return null;
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/useAuth must be used within AuthProvider/);
    spy.mockRestore();
  });
});
