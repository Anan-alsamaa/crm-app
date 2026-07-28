import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@yiji/ui';
import type { AuthUser } from '@yiji/shared-config';
import { auth } from '../directus.js';
import { disconnectSocket, setSessionExpiredHandler } from '../socket.js';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** FR-001 — email a Directus reset link. Never throws (no account enumeration). */
  requestPasswordReset: (email: string, resetUrl?: string) => Promise<void>;
  /** FR-001 — set a new password from an emailed reset token. */
  resetPassword: (token: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount, restore the session from the httpOnly refresh cookie (H-2): the
  // access token is in memory only, so it's gone after a reload — refresh first.
  useEffect(() => {
    let active = true;
    void (async () => {
      const me = await auth.restore();
      if (active) {
        setUser(me);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // When the gateway rejects our token (session expired / invalid), the socket
  // layer fires this once. Drop the dead session and let ProtectedRoute bounce
  // to /login, with a clear message — so a stale token never masquerades as
  // "messaging/attachments are broken".
  useEffect(() => {
    setSessionExpiredHandler(() => {
      toast.error(
        t('auth.sessionExpired', { defaultValue: 'Your session expired. Please sign in again.' }),
      );
      setUser(null);
      void auth.logout().catch(() => undefined); // best-effort: token already dead
    });
    return () => setSessionExpiredHandler(null);
  }, [t]);

  const login = useCallback(async (email: string, password: string) => {
    await auth.login(email, password);
    setUser(await auth.me());
  }, []);

  const logout = useCallback(async () => {
    // Drop the realtime socket BEFORE revoking the token. The gateway only
    // checks the token on the initial handshake, so without this the socket
    // would survive logout — agent stays "online" from the widget's POV
    // until the tab is reloaded or closed.
    disconnectSocket();
    await auth.logout();
    setUser(null);
  }, []);

  // Password reset is deliberately session-less: it runs on the same shared
  // Directus client but never touches `user` — you are still signed out until
  // you sign in with the new password.
  const requestPasswordReset = useCallback(
    (email: string, resetUrl?: string) => auth.requestPasswordReset(email, resetUrl),
    [],
  );
  const resetPassword = useCallback(
    (token: string, password: string) => auth.resetPassword(token, password),
    [],
  );

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, requestPasswordReset, resetPassword }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
