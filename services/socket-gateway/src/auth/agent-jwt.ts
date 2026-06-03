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
