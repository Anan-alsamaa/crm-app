import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { readItems } from '@directus/sdk';
import type { AuthUser } from '@yiji/shared-config';
import { auth, directus } from '../directus.js';
import { PORTAL_PRIVILEGES, type Privilege } from '../privileges.js';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /**
   * What this person's role is allowed to be OFFERED, from their app_roles row.
   *
   * Null until resolved, and null for a role that has no app_roles row at all
   * (the built-in Admin and Agent rows are declarative placeholders with no
   * privileges of their own — see `can`).
   */
  privileges: Record<string, boolean> | null;
  /** True when this person's role grants `priv`. The owner holds everything. */
  can: (priv: Privilege) => boolean;
  /**
   * The project owner — Directus admin_access. Vendors, AI settings and the
   * roles editor's ceiling are gated on THIS, never on a privilege, so no role
   * edit can hand them out.
   */
  isOwner: boolean;
  /** True when there is at least one screen in this portal for them. */
  canUsePortal: boolean;
  /**
   * Returns the identity AND whether this portal has anything for them.
   *
   * The decision travels with the result on purpose: the login screen has to
   * act on it in the same tick, and reading `canUsePortal` out of the context
   * there would read the value from before the sign-in.
   */
  login: (email: string, password: string) => Promise<{ user: AuthUser | null; allowed: boolean }>;
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
  const [privileges, setPrivileges] = useState<Record<string, boolean> | null>(null);

  /**
   * Load the privileges for a role, or null when the role has none of its own.
   *
   * Failures resolve to null rather than throwing: this is a display decision,
   * and a portal that refuses to render because a lookup blipped is worse than
   * one that briefly offers a button Directus will refuse anyway.
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
          {
            filter: { directus_role: { _eq: roleId } },
            fields: ['privileges'],
            limit: 1,
          } as never,
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

  // Restore the session from the httpOnly refresh cookie (H-2): the access token
  // is in memory only, so refresh first on a cold load.
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

  const login = useCallback(
    async (email: string, password: string) => {
      await auth.login(email, password);
      const me = await auth.me();
      setUser(me);
      const privs = await loadPrivileges(me);
      return { user: me, allowed: hasPortalAccess(me, privs) };
    },
    [loadPrivileges],
  );

  const logout = useCallback(async () => {
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

  /**
   * Administrator and the built-in Admin role hold everything.
   *
   * Neither has an app_roles row to read — Admin's is `builtin`, a declarative
   * placeholder for a role defined in code where two security incidents' worth
   * of hardening lives. Reading their privileges from a row that deliberately
   * has none would lock the pair of them out of their own portal.
   */
  const can = useCallback(
    (priv: Privilege): boolean => (isAdmin(user) ? true : privileges?.[priv] === true),
    [user, privileges],
  );
  const isOwner = useMemo(() => isAdmin(user), [user]);

  const canUsePortal = useMemo(() => hasPortalAccess(user, privileges), [user, privileges]);

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

/**
 * The admin portal admits any user with Directus admin access. The authoritative
 * signal is `admin_access` (from the user's policies — Directus 11's model);
 * the role-name allowlist is kept only as a non-regressing fallback for setups
 * where the policy graph isn't readable but the role is conventionally named.
 */
/**
 * Only the Directus owner. The built-in `Admin` role used to be listed here
 * too, which made it all-powerful in this portal regardless of any privilege —
 * so a "WeCare Admin" could never be built on it. It is not listed any more:
 * a CRM administrator is an app role with privileges like everyone else, and
 * what is owner-only stays owner-only.
 */
export const ADMIN_ROLES = ['Administrator'];
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
export const COUPON_MONEY_ROLES = [
  'Administrator',
  'Admin',
  'Supervisor',
  'WeCare Admin',
  'WeCare Supervisor',
];

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

/**
 * Whether this portal has anything for a person.
 *
 * Pure, so the login screen can decide with a freshly fetched privilege set
 * rather than waiting for a re-render to tell it.
 */
export function hasPortalAccess(
  user: AuthUser | null,
  privileges: Record<string, boolean> | null,
): boolean {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return PORTAL_PRIVILEGES.some((p) => privileges?.[p] === true);
}
