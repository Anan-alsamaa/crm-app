import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { YijiDirectusClient } from '@yiji/shared-config';
import { createRoutingRepo } from '../src/processors/directus-repos.js';

/**
 * THE LADDER MUST NOT MISTAKE THE AUTOMATIC WELCOME FOR A REPLY (owner,
 * 2026-10-06).
 *
 * The welcome is stored as `sender_type 'agent'` with no `sender_user`, and it
 * lands a second after the customer's first message. `countOutboundMessages`
 * is the ladder's "did anyone reply since I armed?" — counting the welcome
 * would cancel the escalation of a chat no person has touched.
 */
const request = vi.fn();
const client = { request } as unknown as YijiDirectusClient;
beforeEach(() => request.mockReset());

/** The query a recorded Directus SDK command would really have sent. */
function queryOf(call: number): { filter?: Record<string, unknown> } {
  const cmd = request.mock.calls[call]![0] as () => { params?: { filter?: unknown } };
  return (cmd().params ?? {}) as { filter?: Record<string, unknown> };
}

describe('countOutboundMessages', () => {
  it('counts only messages a PERSON sent (sender_user not null)', async () => {
    request.mockResolvedValueOnce([{ count: { id: 2 } }]);
    const n = await createRoutingRepo(client).countOutboundMessages('conv-1');
    expect(n).toBe(2);
    const filter = queryOf(0).filter!;
    expect(filter).toMatchObject({
      conversation: { _eq: 'conv-1' },
      sender_type: { _eq: 'agent' },
      sender_user: { _nnull: true },
    });
  });
});
