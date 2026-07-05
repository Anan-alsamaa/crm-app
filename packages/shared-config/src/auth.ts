import {
  createDirectus,
  authentication,
  rest,
  readMe,
  type AuthenticationStorage,
} from '@directus/sdk';

/**
 * Directus auth client for the portals (login / refresh / logout / me).
 *
 * Auth mode is COOKIE (H-2): Directus stores the long-lived refresh token in an
 * httpOnly, Secure, SameSite cookie that JavaScript cannot read, so an XSS bug
 * can't exfiltrate a persistent credential. Only the short-lived access token is
 * held in memory (default in-memory storage — nothing is written to
 * localStorage). On a cold page load the access token is gone, so `restore()`
 * refreshes from the cookie first. Requires the Directus server to send
 * `Access-Control-Allow-Credentials` (CORS_CREDENTIALS=true) and the requests to
 * use `credentials: 'include'` (set below).
 */

export interface AuthUser {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
  role: { id: string; name: string } | null;
  /**
   * Whether this user has Directus admin access. In Directus 11 admin access is
   * a property of *policies* (attached to the role and/or directly to the user),
   * not the role name — so this is the authoritative signal for admin gating.
   */
  admin_access: boolean;
}

/** Shape of a policy junction row as returned by readMe (role + direct). */
interface PolicyLink {
  policy: { admin_access: boolean | null } | null;
}
interface RawMe {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
  role: { id: string; name: string; policies?: PolicyLink[] } | null;
  policies?: PolicyLink[];
}

const grantsAdmin = (links: PolicyLink[] | undefined): boolean =>
  (links ?? []).some((l) => l.policy?.admin_access === true);

export interface AuthClientOptions {
  url: string;
  /**
   * Optional token store. Defaults to in-memory (H-2). Tests may inject a stub;
   * production should leave it unset so the access token never persists.
   */
  storage?: AuthenticationStorage;
}

export function createAuthClient({ url, storage }: AuthClientOptions) {
  const client = createDirectus(url)
    .with(
      authentication('cookie', {
        credentials: 'include',
        autoRefresh: true,
        ...(storage ? { storage } : {}),
      }),
    )
    .with(rest({ credentials: 'include' }));

  async function me(): Promise<AuthUser | null> {
    // Identity + role name is the reliable core and MUST load for a valid
    // session. It is fetched on its own so that a hiccup computing admin_access
    // (below) can never null out the whole user — which previously locked a real
    // admin out of the admin portal ("Your account does not have administrator
    // access") on any transient Directus slowness or policy-graph read quirk.
    let raw: RawMe;
    try {
      raw = (await client.request(
        readMe({
          fields: ['id', 'email', 'first_name', 'last_name', 'status', { role: ['id', 'name'] }],
        }),
      )) as RawMe;
    } catch {
      return null; // genuinely unauthenticated / Directus unreachable
    }
    // admin_access is computed from the policy graph as a SEPARATE, best-effort
    // step. If it fails, we leave it false and let isAdmin()'s role-name
    // allowlist decide — an admin is never falsely locked out by a policy read.
    let admin_access = false;
    try {
      const acc = (await client.request(
        readMe({
          // role.policies + direct policies carry admin_access in Directus 11.
          fields: [
            { role: [{ policies: [{ policy: ['admin_access'] }] }] },
            { policies: [{ policy: ['admin_access'] }] },
          ],
        }),
      )) as RawMe;
      admin_access = grantsAdmin(acc.role?.policies) || grantsAdmin(acc.policies);
    } catch {
      /* keep admin_access=false; isAdmin() falls back to the role-name allowlist */
    }
    return {
      id: raw.id,
      email: raw.email,
      first_name: raw.first_name,
      last_name: raw.last_name,
      status: raw.status,
      role: raw.role ? { id: raw.role.id, name: raw.role.name } : null,
      admin_access,
    };
  }

  return {
    /** Underlying Directus client (already authenticated after login). */
    client,
    async login(email: string, password: string): Promise<void> {
      await client.login(email, password);
    },
    async logout(): Promise<void> {
      await client.logout();
    },
    async refresh(): Promise<void> {
      await client.refresh();
    },
    /** Current access token (for authenticating the realtime socket). */
    async getToken(): Promise<string | null> {
      return client.getToken();
    },
    /** Current user with role name + computed admin_access, or null if not authenticated. */
    me,
    /**
     * Restore a session on cold load. The access token lives in memory only, so
     * first refresh from the httpOnly cookie; returns null when there is no
     * valid session cookie (i.e. genuinely logged out).
     */
    async restore(): Promise<AuthUser | null> {
      try {
        await client.refresh();
      } catch {
        return null;
      }
      return me();
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;

/** localStorage-backed AuthenticationStorage factory (browser only). */
export function browserAuthStorage(
  storageKey: string,
  ls: { getItem(k: string): string | null; setItem(k: string, v: string): void },
): AuthenticationStorage {
  return {
    get() {
      const raw = ls.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    },
    set(value) {
      ls.setItem(storageKey, JSON.stringify(value));
    },
  };
}
