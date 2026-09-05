import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@yiji/ui';
import type { AuthUser } from '@yiji/shared-config';
import { readItems } from '@directus/sdk';
import { opensPortal, type Privilege } from '@yiji/shared-types';
import { auth, directus } from '../directus.js';
import { disconnectSocket, setSessionExpiredHandler } from '../socket.js';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /**
   * What this person's role may be OFFERED, from their app_roles row. Null
   * until resolved, and null for a role with no row (the code-defined Agent
   * and Admin roles — see `can`).
   */
  privileges: Record<string, boolean> | null;
  /** True when the role grants `priv`. The project owner holds everything. */
  can: (priv: Privilege) => boolean;
  /** Directus admin_access — the project owner. */
  isOwner: boolean;
  /** True when at least one screen in THIS portal is open to them. */
  canUsePortal: boolean;
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
  const [privileges, setPrivileges] = useState<Record<string, boolean> | null>(null);

  /**
   * The role's privileges, or null when it has none of its own. Failures
   * resolve to null rather than throwing: a portal that refuses to render
   * because a lookup blipped is worse than one that briefly offers a page
   * Directus will refuse anyway.
   */
  const loadPrivileges = useCallback(async (me: AuthUser | null) => {
    const roleId = me?.role?.id;
    if (!roleId) {
      setPrivileges(null);
      return null;
    }
    try {
      const rows = (await directus.request(
        readItems(
          'app_roles' as never,
          { filter: { directus_role: { _eq: roleId } }, fields: ['privileges'], limit: 1 } as never,
        ),
      )) as unknown as Array<{ privileges: Record<string, boolean> | null }>;
      const next = rows[0]?.privileges ?? null;
      setPrivileges(next);
      return next;
    } catch {
      setPrivileges(null);
      return null;
    }
  }, []);

  // On mount, restore the session from the httpOnly refresh cookie (H-2): the
  // access token is in memory only, so it's gone after a reload — refresh first.
  useEffect(() => {
    let active = true;
    void (async () => {
      const me = await auth.restore();
      if (!active) return;
      setUser(me);
      // Privileges before loading:false, so nothing renders a nav it is about
      // to have to take items out of.
      await loadPrivileges(me);
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [loadPrivileges]);

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

  const login = useCallback(
    async (email: string, password: string) => {
      await auth.login(email, password);
      const me = await auth.me();
      setUser(me);
      await loadPrivileges(me);
    },
    [loadPrivileges],
  );

  const logout = useCallback(async () => {
    // Drop the realtime socket BEFORE revoking the token. The gateway only
    // checks the token on the initial handshake, so without this the socket
    // would survive logout — agent stays "online" from the widget's POV
    // until the tab is reloaded or closed.
    disconnectSocket();
    await auth.logout();
    setUser(null);
    setPrivileges(null);
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

  const isOwner = user?.admin_access === true;
  /**
   * The code-defined Agent and Admin roles have no app_roles row, so their
   * privileges read as null. They are legacy: every person is meant to sit on
   * an app role now. Until the last of them is moved, treat them as a full
   * agent rather than locking out an account nobody has migrated yet.
   */
  const legacyAgent = !!user?.role && ['Agent', 'Admin'].includes(user.role.name);
  const can = useCallback(
    (priv: Privilege): boolean =>
      isOwner || (legacyAgent && privileges === null) || privileges?.[priv] === true,
    [isOwner, legacyAgent, privileges],
  );
  const canUsePortal =
    isOwner || (legacyAgent && privileges === null) || opensPortal(privileges, 'agent');

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        privileges,
        can,
        isOwner,
        canUsePortal,
        login,
        logout,
        requestPasswordReset,
        resetPassword,
      }}
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
