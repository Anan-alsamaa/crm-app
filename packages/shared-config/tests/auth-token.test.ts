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

const { createDirectus, refresh, getToken } = vi.hoisted(() => {
  const refresh = vi.fn();
  const getToken = vi.fn();
  const client: Record<string, unknown> = { refresh, getToken };
  client.with = () => client;
  return { createDirectus: vi.fn(() => client), refresh, getToken };
});

vi.mock('@directus/sdk', () => ({
  createDirectus,
  authentication: () => (c: unknown) => c,
  rest: () => (c: unknown) => c,
  readMe: () => ({}),
  passwordRequest: () => ({}),
  passwordReset: () => ({}),
}));

import { browserAuthStorage, createAuthClient } from '../src/auth.js';

beforeEach(() => {
  refresh.mockReset();
  getToken.mockReset();
});

describe('getToken — the cold-load gap that logged agents out', () => {
  it('returns the in-memory token when there is one, without refreshing', async () => {
    getToken.mockResolvedValue('live-token');
    const auth = createAuthClient({ url: 'http://directus.test' });

    expect(await auth.getToken()).toBe('live-token');
    // A perfectly good token must not trigger a network round-trip on every
    // socket (re)connection — Socket.IO re-invokes the auth callback each time.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('REFRESHES when memory is empty, which is the state right after a reload', async () => {
    // First read: nothing in memory (fresh page). After the refresh lands the
    // SDK holds a real token.
    getToken.mockResolvedValueOnce(null).mockResolvedValueOnce('restored-token');
    refresh.mockResolvedValue(undefined);
    const auth = createAuthClient({ url: 'http://directus.test' });

    expect(await auth.getToken()).toBe('restored-token');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('still reports null when the refresh itself fails — genuinely signed out', async () => {
    getToken.mockResolvedValue(null);
    refresh.mockRejectedValue(new Error('no session cookie'));
    const auth = createAuthClient({ url: 'http://directus.test' });

    // The caller treats null as expiry and sends them to the login screen,
    // which is correct HERE and was wrong for the race above.
    expect(await auth.getToken()).toBeNull();
  });
});

/*
 * TWO AGENTS, ONE MACHINE.
 *
 * The session store must be scoped to the TAB. When it was `localStorage` —
 * shared by every tab on the origin — opening the portal in a second tab
 * adopted whoever the first tab was signed in as, and signing in as somebody
 * else there overwrote the shared key so the first tab became the second agent
 * on its next refresh (owner, 2026-09-16). One desk, two people, each
 * hijacking the other.
 *
 * These pin the property that matters rather than the API used to get it: two
 * stores that do not see each other keep two identities apart, and one shared
 * store does not. The second case is the bug, written down so it cannot come
 * back quietly.
 */
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
