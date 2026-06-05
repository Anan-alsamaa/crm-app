import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const { authMock, disconnectSocket } = vi.hoisted(() => ({
  authMock: { me: vi.fn(), login: vi.fn(), logout: vi.fn() },
  disconnectSocket: vi.fn(),
}));
vi.mock('../src/lib/directus.js', () => ({ auth: authMock }));
vi.mock('../src/lib/socket.js', () => ({ disconnectSocket }));

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
  authMock.login.mockReset();
  authMock.logout.mockReset();
  disconnectSocket.mockReset();
});

describe('AuthProvider / useAuth', () => {
  it('restores the session on mount', async () => {
    authMock.me.mockResolvedValue(me);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:agent@x.com'));
  });

  it('shows anon when no session is restored', async () => {
    authMock.me.mockResolvedValue(null);
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anon'));
  });

  it('login authenticates and loads the user', async () => {
    authMock.me.mockResolvedValueOnce(null).mockResolvedValueOnce(me);
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
    authMock.me.mockResolvedValue(me);
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
