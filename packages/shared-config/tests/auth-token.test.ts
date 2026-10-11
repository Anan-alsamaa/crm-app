import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * "REFRESHING THE AGENT PORTAL LOGS ME OUT."
 *
 * The access token lives in memory only (H-2): the durable half of the session
 * is an httpOnly refresh cookie. So for a moment after every page load there is
 * no access token at all, and the portal opens its realtime socket on mount —
 * the inbox, the notification bell and the new-message sound all call
 * `getSocket()` without waiting for the session to be restored.
 *
 * `getToken()` used to hand back that empty value. The socket then connected
 * with no token, the gateway answered "missing token", and the client read a
 * rejected handshake as a dead session and threw the agent out to /login.
 * Reported from production on 2026-09-14, with the gateway logging nine
 * "connection rejected: missing token" lines inside 1.5 seconds.
 *
 * The contract pinned here: an empty in-memory token means ASK THE COOKIE, not
 * "signed out". Only when the refresh itself fails is the session really gone.
 */

/*
 * The SDK client is simulated faithfully where it matters: its `refresh`
 * ERASES the stored session before calling the server (as @directus/sdk 17
 * does), then stores the new tokens - or throws, leaving the session erased.
 */
const sdk = vi.hoisted(() => ({
  storage: null as null | {
    get: () => unknown;
    set: (v: unknown) => unknown;
  },
  server: vi.fn(),
}));
const { createDirectus, refresh, logout } = vi.hoisted(() => {
  const refresh = vi.fn(async () => {
    const before = (await sdk.storage!.get()) as { refresh_token?: string | null } | null;
    await sdk.storage!.set({
      access_token: null,
      refresh_token: null,
      expires: null,
      expires_at: null,
    });
    const next = await sdk.server(before?.refresh_token ?? null);
    await sdk.storage!.set({ ...next, expires_at: Date.now() + (next.expires as number) });
  });
  const logout = vi.fn(async () => undefined);
  const client: Record<string, unknown> = { refresh, logout, getToken: vi.fn() };
  client.with = (plugin: (c: unknown) => unknown) => {
    plugin(client);
    return client;
  };
  return { createDirectus: vi.fn(() => client), refresh, logout };
});

vi.mock('@directus/sdk', () => ({
  createDirectus,
  authentication: (_mode: string, opts: { storage: typeof sdk.storage }) => (c: unknown) => {
    sdk.storage = opts.storage;
    return c;
  },
  rest: () => (c: unknown) => c,
  readMe: () => ({}),
  passwordRequest: () => ({}),
  passwordReset: () => ({}),
}));

import { browserAuthStorage, createAuthClient } from '../src/auth.js';

const fresh = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires: 900_000,
});
const refused = (status: number) => Object.assign(new Error('refused'), { response: { status } });

function signedIn(expiresInMs: number) {
  const auth = createAuthClient({ url: 'http://directus.test', mode: 'json' });
  void sdk.storage!.set({
    access_token: 'access-0',
    refresh_token: 'refresh-0',
    expires: 900_000,
    expires_at: Date.now() + expiresInMs,
  });
  return auth;
}

beforeEach(() => {
  refresh.mockClear();
  logout.mockReset();
  sdk.server.mockReset();
});

describe('getToken - the session survives everything but a real refusal', () => {
  it('returns a live token without refreshing', async () => {
    const auth = signedIn(10 * 60_000);
    expect(await auth.getToken()).toBe('access-0');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes a token about to expire', async () => {
    sdk.server.mockResolvedValue(fresh(1));
    const auth = signedIn(5_000);
    expect(await auth.getToken()).toBe('access-1');
    expect(sdk.server).toHaveBeenCalledWith('refresh-0');
  });

  /* 2026-10-11: two callers at once made two refreshes; the second found the
     session already erased and sent NO token (the 400s on /auth/refresh). */
  it('makes ONE refresh for many callers at once', async () => {
    sdk.server.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return fresh(2);
    });
    const auth = signedIn(-1);
    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(sdk.server).toHaveBeenCalledTimes(1);
  });

  /* 2026-10-11: a refresh during a Directus restart (deploy) signed agents out. */
  it('KEEPS the session when the refresh fails without a refusal, and retries next time', async () => {
    sdk.server.mockRejectedValueOnce(refused(503)).mockResolvedValueOnce(fresh(3));
    const auth = signedIn(-1);
    await auth.getToken();
    expect((sdk.storage!.get() as { refresh_token: string }).refresh_token).toBe('refresh-0');
    expect(await auth.getToken()).toBe('access-3');
  });

  it('signs out when Directus refuses the session', async () => {
    sdk.server.mockRejectedValue(refused(401));
    const auth = signedIn(-1);
    expect(await auth.getToken()).toBeNull();
    expect((sdk.storage!.get() as { refresh_token: string | null }).refresh_token).toBeNull();
  });

  it('restore keeps a session through a passing failure, drops it on a refusal', async () => {
    sdk.server.mockRejectedValueOnce(refused(502));
    const kept = signedIn(-1);
    await kept.restore();
    expect((sdk.storage!.get() as { refresh_token: string }).refresh_token).toBe('refresh-0');
    sdk.server.mockRejectedValueOnce(refused(401));
    const gone = signedIn(-1);
    expect(await gone.restore()).toBeNull();
  });

  it('logout clears the session even when the server cannot be reached', async () => {
    logout.mockRejectedValue(new Error('network'));
    const auth = signedIn(10 * 60_000);
    await expect(auth.logout()).rejects.toThrow('network');
    expect((sdk.storage!.get() as { refresh_token: string | null }).refresh_token).toBeNull();
  });
});

describe('a signed-in identity belongs to the tab, not the browser', () => {
  /** A Web Storage stand-in. One instance per "tab". */
  const makeStore = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it('keeps two tabs on separate sessions when each has its own store', () => {
    const tabA = browserAuthStorage('yiji.agent.session', makeStore());
    const tabB = browserAuthStorage('yiji.agent.session', makeStore());

    tabA.set({ access_token: 'nada', refresh_token: 'r-nada', expires_at: 1, expires: 1 });
    // A fresh tab starts signed out rather than inheriting whoever is in tab A.
    expect(tabB.get()).toBeNull();

    tabB.set({ access_token: 'shatha', refresh_token: 'r-shatha', expires_at: 1, expires: 1 });
    // And signing in as somebody else does not reach back into the first tab.
    expect(tabA.get()?.access_token).toBe('nada');
    expect(tabB.get()?.access_token).toBe('shatha');
  });

  it('DEMONSTRATES the bug: one shared store collapses both tabs into one user', () => {
    // Exactly what `localStorage` does — the same backing store handed to both.
    const shared = makeStore();
    const tabA = browserAuthStorage('yiji.agent.session', shared);
    const tabB = browserAuthStorage('yiji.agent.session', shared);

    tabA.set({ access_token: 'nada', refresh_token: 'r-nada', expires_at: 1, expires: 1 });
    expect(tabB.get()?.access_token).toBe('nada'); // tab B adopted tab A

    tabB.set({ access_token: 'shatha', refresh_token: 'r-shatha', expires_at: 1, expires: 1 });
    expect(tabA.get()?.access_token).toBe('shatha'); // ...and tab A flipped back
  });
});
