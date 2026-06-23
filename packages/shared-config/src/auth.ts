import {
  createDirectus,
  authentication,
  rest,
  readMe,
  type AuthenticationStorage,
} from '@directus/sdk';

/**
 * Directus auth client for the portals (login / refresh / logout / me).
 * Token storage is injected (the browser passes a localStorage-backed store)
 * so this module stays DOM-free and usable from any environment.
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
  storage: AuthenticationStorage;
}

export function createAuthClient({ url, storage }: AuthClientOptions) {
  const client = createDirectus(url)
    .with(authentication('json', { storage, autoRefresh: true }))
    .with(rest());

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
    async me(): Promise<AuthUser | null> {
      try {
        const me = (await client.request(
          readMe({
            fields: [
              'id',
              'email',
              'first_name',
              'last_name',
              'status',
              // role.policies + direct policies carry admin_access in Directus 11.
              { role: ['id', 'name', { policies: [{ policy: ['admin_access'] }] }] },
              { policies: [{ policy: ['admin_access'] }] },
            ],
          }),
        )) as RawMe;
        return {
          id: me.id,
          email: me.email,
          first_name: me.first_name,
          last_name: me.last_name,
          status: me.status,
          role: me.role ? { id: me.role.id, name: me.role.name } : null,
          admin_access: grantsAdmin(me.role?.policies) || grantsAdmin(me.policies),
        };
      } catch {
        return null;
      }
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
