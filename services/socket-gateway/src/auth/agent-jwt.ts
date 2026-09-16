import { createDirectus, rest, staticToken, readMe } from '@directus/sdk';

/**
 * Validate an agent's Directus access token by calling /users/me as that user
 * (spec Section 10). Returns the agent identity, or null if the token is invalid.
 */
export interface AgentIdentity {
  id: string;
  role: string | null;
}

export async function validateAgentToken(
  directusUrl: string,
  token: string,
): Promise<AgentIdentity | null> {
  try {
    const client = createDirectus(directusUrl).with(staticToken(token)).with(rest());
    const me = (await client.request(readMe({ fields: ['id', { role: ['name'] }] }))) as {
      id: string;
      role: { name: string } | null;
    };
    return { id: me.id, role: me.role?.name ?? null };
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
