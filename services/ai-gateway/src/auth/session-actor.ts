import { effectivePrivileges } from '@yiji/shared-types';

/**
 * WHO IS ASKING, decided by Directus from the caller's OWN session - the
 * marketing engine's rule (engine-routes.ts), as a reusable piece:
 *   - `/users/me` names the person and their role;
 *   - their role's `app_roles` row (every role may read its own) gives the
 *     privileges, filled in by `effectivePrivileges` exactly as the portals
 *     do; the Administrator role holds everything.
 * Cached per token for a minute. `unavailable` = Directus could not say.
 */
export interface SessionActor {
  id: string;
  isAdmin: boolean;
  privileges: Record<string, boolean>;
}

export interface SessionActorResolver {
  resolve(token: string): Promise<SessionActor | null | 'unavailable'>;
  /** The caller's own read of one item: true = they may see it. */
  canRead(token: string, collection: string, id: string): Promise<boolean | 'unavailable'>;
}

/** Roles that hold every switch (mirrors the portals' ADMIN_ROLES). */
export const SESSION_ADMIN_ROLES = ['Administrator'];

export function bearerOf(header: string | undefined): string | null {
  return /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() || null;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createSessionActorResolver(opts: {
  directusUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): SessionActorResolver {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.directusUrl.replace(/\/+$/, '');
  const cache = new Map<string, { actor: SessionActor | null; at: number }>();

  async function asCaller<T>(token: string, path: string): Promise<{ status: number; data?: T }> {
    const res = await f(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { status: res.status };
    const body = (await res.json().catch(() => ({}))) as { data?: T };
    return { status: res.status, data: body.data };
  }

  return {
    async resolve(token) {
      const hit = cache.get(token);
      if (hit && now() - hit.at < 60_000) return hit.actor;
      try {
        const me = await asCaller<{ id?: string; role?: { id?: string; name?: string } | null }>(
          token,
          '/users/me?fields=id,role.id,role.name',
        );
        if (me.status >= 500) return 'unavailable';
        if (me.status === 401 || me.status === 403 || !me.data?.id) {
          cache.set(token, { actor: null, at: now() });
          return null;
        }
        const roleId = me.data.role?.id ?? null;
        const roleName = me.data.role?.name ?? '';
        const isAdmin = SESSION_ADMIN_ROLES.includes(roleName);
        let stored: Record<string, boolean> | null = null;
        if (roleId && !isAdmin) {
          const q = new URLSearchParams({
            filter: JSON.stringify({ directus_role: { _eq: roleId } }),
            fields: 'privileges',
            limit: '1',
          });
          const rows = await asCaller<Array<{ privileges: unknown }>>(
            token,
            `/items/app_roles?${q.toString()}`,
          );
          if (rows.status >= 500) return 'unavailable';
          const raw = rows.data?.[0]?.privileges;
          stored = (typeof raw === 'string' ? safeJson(raw) : raw) as Record<
            string,
            boolean
          > | null;
        }
        const actor: SessionActor = {
          id: me.data.id,
          isAdmin,
          privileges: isAdmin ? {} : effectivePrivileges(stored, roleName),
        };
        cache.set(token, { actor, at: now() });
        if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
        return actor;
      } catch {
        return 'unavailable';
      }
    },
    async canRead(token, collection, id) {
      try {
        const r = await asCaller<{ id?: string }>(
          token,
          `/items/${collection}/${encodeURIComponent(id)}?fields=id`,
        );
        if (r.status >= 500) return 'unavailable';
        return r.status === 200 && !!r.data?.id;
      } catch {
        return 'unavailable';
      }
    },
  };
}

/** Holds `key`, or is the Administrator (who holds everything). */
export function actorHolds(actor: SessionActor, key: string): boolean {
  return actor.isAdmin || actor.privileges[key] === true;
}
