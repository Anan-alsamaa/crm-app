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

import { validateAgentToken } from '../src/auth/agent-jwt.js';

beforeEach(() => {
  request.mockReset();
});

describe('validateAgentToken', () => {
  it('returns the identity with role name on success', async () => {
    request.mockResolvedValueOnce({ id: 'agent-1', role: { name: 'Agent' } });
    expect(await validateAgentToken('http://localhost:8055', 'tok')).toEqual({
      id: 'agent-1',
      role: 'Agent',
    });
  });

  it('coerces a missing role to null', async () => {
    request.mockResolvedValueOnce({ id: 'agent-2', role: null });
    expect(await validateAgentToken('http://localhost:8055', 'tok')).toEqual({
      id: 'agent-2',
      role: null,
    });
  });

  it('returns null when the token is rejected (request throws)', async () => {
    request.mockRejectedValueOnce(new Error('401'));
    expect(await validateAgentToken('http://localhost:8055', 'bad')).toBeNull();
  });
});
