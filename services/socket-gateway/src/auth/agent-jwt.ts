import { createDirectus, rest, staticToken, readMe, readItems } from '@directus/sdk';
import { ALL_PRIVILEGES, effectivePrivileges } from '@yiji/shared-types';

/**
 * Validate an agent's Directus access token by calling /users/me as that user
 * (spec Section 10). Returns the agent identity, or null if the token is invalid.
 */
export interface AgentIdentity {
  id: string;
  role: string | null;
  /**
   * What the role may do — its app_roles row, defaults filled in (owner,
   * 2026-10-06). The gateway's endpoints check THESE instead of role names, so
   * the Roles page decides who may start a chat, import, or run a report.
   */
  privileges: Record<string, boolean>;
}

/**
 * Roles with no app_roles row that have always passed every check here: the
 * owner (Administrator) and the two code-defined roles. Anyone else without a
 * row gets the defaults alone.
 */
const ROWLESS_FULL_ROLES = ['administrator', 'admin', 'agent'];

export function rolePrivileges(
  roleName: string | null,
  row: { privileges: unknown } | null,
): Record<string, boolean> {
  if (!row && ROWLESS_FULL_ROLES.includes(String(roleName ?? '').toLowerCase())) {
    return Object.fromEntries(ALL_PRIVILEGES.map((k) => [k, true]));
  }
  const raw = row?.privileges;
  let stored: Record<string, boolean> | null = null;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw) as Record<string, boolean>;
    } catch {
      stored = null;
    }
  } else if (raw && typeof raw === 'object') stored = raw as Record<string, boolean>;
  return effectivePrivileges(stored, roleName);
}

export async function validateAgentToken(
  directusUrl: string,
  token: string,
): Promise<AgentIdentity | null> {
  try {
    const client = createDirectus(directusUrl).with(staticToken(token)).with(rest());
    const me = (await client.request(readMe({ fields: ['id', { role: ['id', 'name'] }] }))) as {
      id: string;
      role: { id?: string; name: string } | null;
    };
    const role = me.role?.name ?? null;
    /* Read with the agent's OWN token: every app role may read app_roles
       (baseline grant). A failed read falls back to the defaults, which are
       what the role could do before the Roles page decided it. */
    let row: { privileges: unknown } | null = null;
    if (me.role?.id) {
      try {
        const rows = (await client.request(
          readItems(
            'app_roles' as never,
            {
              filter: { directus_role: { _eq: me.role.id } },
              fields: ['privileges'],
              limit: 1,
            } as never,
          ),
        )) as unknown as Array<{ privileges: unknown }> | undefined;
        row = rows?.[0] ?? null;
      } catch {
        row = null;
      }
    }
    return { id: me.id, role, privileges: rolePrivileges(role, row) };
  } catch {
    return null;
  }
}

/**
 * Does this token belong to somebody with Directus ADMIN ACCESS?
 *
 * Separate from `validateAgentToken` because that answers a different question.
 * A role NAME is a label anybody with the roles editor can create — "Admin" is
 * a string — whereas `admin_access` is the property Directus itself enforces,
 * and in Directus 11 it lives on POLICIES attached to the role and/or directly
 * to the user, never on the role row.
 *
 * Used to gate releasing a new build to production. That action changes what
 * every agent's browser loads, so it is fenced by the strongest signal
 * available rather than by a name that happens to read as senior.
 *
 * Deliberately fails CLOSED: any error, any unreadable policy graph, and the
 * answer is false. The cost of a wrong `false` is that an owner re-clicks; the
 * cost of a wrong `true` is an unreviewed release to the whole floor.
 */
export async function tokenHasAdminAccess(
  directusUrl: string,
  token: string,
): Promise<{ id: string } | null> {
  try {
    const client = createDirectus(directusUrl).with(staticToken(token)).with(rest());
    const me = (await client.request(
      readMe({
        fields: [
          'id',
          { role: [{ policies: [{ policy: ['admin_access'] }] }] },
          { policies: [{ policy: ['admin_access'] }] },
        ],
      }),
    )) as {
      id: string;
      role: { policies?: Array<{ policy: { admin_access: boolean | null } | null }> } | null;
      policies?: Array<{ policy: { admin_access: boolean | null } | null }>;
    };
    const grants = (
      links: Array<{ policy: { admin_access: boolean | null } | null }> | undefined,
    ) => (links ?? []).some((l) => l.policy?.admin_access === true);
    if (!grants(me.role?.policies) && !grants(me.policies)) return null;
    return { id: me.id };
  } catch {
    return null;
  }
}
