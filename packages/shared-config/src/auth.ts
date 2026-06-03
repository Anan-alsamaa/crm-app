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
}

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
    /** Current user with role name, or null if not authenticated. */
    async me(): Promise<AuthUser | null> {
      try {
        return (await client.request(
          readMe({
            fields: ['id', 'email', 'first_name', 'last_name', 'status', { role: ['id', 'name'] }],
          }),
        )) as AuthUser;
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
