import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Directus SDK so validateAgentToken can be exercised without a live
// server. createDirectus(...).with(...).with(...) must remain chainable.
// `request` is hoisted so it is initialised before the hoisted vi.mock factory.
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@directus/sdk', () => {
  const client = { request, with: vi.fn() };
  client.with.mockReturnValue(client);
  return {
    createDirectus: vi.fn(() => client),
    rest: vi.fn(() => ({})),
    staticToken: vi.fn(() => ({})),
    readMe: vi.fn(() => ({})),
  };
});

import { AuthUnavailableError, validateAgentToken } from '../src/auth/agent-jwt.js';

beforeEach(() => {
  request.mockReset();
});

describe('validateAgentToken', () => {
  it('returns the identity with role name on success', async () => {
    request.mockResolvedValueOnce({ id: 'agent-1', role: { name: 'Agent' } });
    expect(await validateAgentToken('http://localhost:8055', 'tok')).toMatchObject({
      id: 'agent-1',
      role: 'Agent',
    });
  });

  it('coerces a missing role to null', async () => {
    request.mockResolvedValueOnce({ id: 'agent-2', role: null });
    expect(await validateAgentToken('http://localhost:8055', 'tok')).toMatchObject({
      id: 'agent-2',
      role: null,
    });
  });

  it('returns null when Directus REFUSES the token (401)', async () => {
    request.mockRejectedValueOnce({ errors: [{ message: 'Invalid' }], response: { status: 401 } });
    expect(await validateAgentToken('http://localhost:8055', 'bad')).toBeNull();
  });

  /* Owner, 2026-10-11: a slow or restarting Directus signed agents out. An
     outage is "try again", never "invalid token". */
  it('throws AuthUnavailableError when Directus cannot answer, never null', async () => {
    request.mockRejectedValueOnce({ response: { status: 503 } });
    await expect(validateAgentToken('http://localhost:8055', 'good')).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
    request.mockRejectedValueOnce(new Error('fetch failed'));
    const err = await validateAgentToken('http://localhost:8055', 'good').catch((e: Error) => e);
    // The portal signs out on "token"/"unauthorized" - this message must not say either.
    expect(String((err as Error).message)).not.toMatch(/token|unauthorized/i);
  });
});
