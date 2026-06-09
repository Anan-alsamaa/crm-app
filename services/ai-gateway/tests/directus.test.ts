import { describe, it, expect, vi, beforeEach } from 'vitest';

const request = vi.fn();
vi.mock('@yiji/shared-config', () => ({
  createServiceClient: () => ({ request }),
}));

import { GatewayDirectus } from '../src/directus/index.js';

beforeEach(() => request.mockReset());

describe('GatewayDirectus.getConversation', () => {
  function gateway(): GatewayDirectus {
    return new GatewayDirectus('http://localhost:8055', 'svc-token');
  }

  it('returns the conversation header plus its messages', async () => {
    request
      .mockResolvedValueOnce({
        id: 'conv-1',
        status: 'open',
        priority: 'medium',
        vendor: 'v-1',
        contact: { id: 'c-1', name: 'Demo', email: 'd@e.com' },
      })
      .mockResolvedValueOnce([
        {
          id: 'm-1',
          sender_type: 'customer',
          content: 'hi',
          is_internal_note: false,
          date_created: '2026-06-01T10:00:00Z',
        },
      ]);
    const ctx = await gateway().getConversation('conv-1');
    expect(ctx?.id).toBe('conv-1');
    expect(ctx?.messages).toHaveLength(1);
    expect(ctx?.contact?.email).toBe('d@e.com');
  });

  it('defaults messages to an empty array when none come back', async () => {
    request
      .mockResolvedValueOnce({
        id: 'conv-2',
        status: 'open',
        priority: 'low',
        vendor: 'v',
        contact: null,
      })
      .mockResolvedValueOnce(null);
    const ctx = await gateway().getConversation('conv-2');
    expect(ctx?.messages).toEqual([]);
  });

  it('returns null when the conversation read throws', async () => {
    request.mockRejectedValueOnce(new Error('404'));
    expect(await gateway().getConversation('absent')).toBeNull();
  });

  it('passes a custom message limit through without error', async () => {
    request.mockResolvedValueOnce({
      id: 'c',
      status: 'open',
      priority: 'low',
      vendor: 'v',
      contact: null,
    });
    request.mockResolvedValueOnce([]);
    const ctx = await gateway().getConversation('c', 10);
    expect(ctx?.id).toBe('c');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
