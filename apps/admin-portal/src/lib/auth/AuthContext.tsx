import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { AuthUser } from '@yiji/shared-config';
import { auth } from '../directus.js';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser | null>;
  logout: () => Promise<void>;
  /** FR-001 — email a Directus reset link. Never throws (no account enumeration). */
  requestPasswordReset: (email: string, resetUrl?: string) => Promise<void>;
  /** FR-001 — set a new password from an emailed reset token. */
  resetPassword: (token: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session from the httpOnly refresh cookie (H-2): the access token
  // is in memory only, so refresh first on a cold load.
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

  const login = useCallback(async (email: string, password: string) => {
    await auth.login(email, password);
    const me = await auth.me();
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
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

/**
 * The admin portal admits any user with Directus admin access. The authoritative
 * signal is `admin_access` (from the user's policies — Directus 11's model);
 * the role-name allowlist is kept only as a non-regressing fallback for setups
 * where the policy graph isn't readable but the role is conventionally named.
 */
export const ADMIN_ROLES = ['Administrator', 'Admin'];
export function isAdmin(user: AuthUser | null): boolean {
  if (!user) return false;
  return user.admin_access || (!!user.role && ADMIN_ROLES.includes(user.role.name));
}

/**
 * Roles allowed to see COUPON MONEY — the riyal totals on the dashboard.
 *
 * Narrower than `isAdmin` on purpose. Compensation spend is a commercial
 * figure: it says what the operation is paying out to keep customers, which is
 * not something every person who can open this portal needs, and it is the
 * kind of number that gets screenshotted. Default deny, and widen it when
 * somebody asks.
 */
export const COUPON_MONEY_ROLES = ['Administrator', 'Admin', 'Supervisor'];

/**
 * Whether to render the coupon spend figures.
 *
 * The UI check is NOT the security boundary — Directus decides what a session
 * may read from `coupon_approvals`, and a role without that permission gets
 * nothing back however the page is styled. This exists so a role that CAN read
 * the rows for its own work is not shown the aggregate payout across the whole
 * operation as a headline number.
 */
export function canSeeCouponMoney(user: AuthUser | null): boolean {
  if (!user) return false;
  return !!user.role && COUPON_MONEY_ROLES.includes(user.role.name);
}
