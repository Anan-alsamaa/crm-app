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

  it('groups messages per conversation, oldest-first, truncated', async () => {
    request
      .mockResolvedValueOnce([{ id: 'c-1' }, { id: 'c-2' }])
      // Directus returns newest-first (sort: -date_created).
      .mockResolvedValueOnce([
        { conversation: 'c-1', sender_type: 'agent', content: 'On it.' },
        { conversation: 'c-1', sender_type: 'customer', content: 'Refund please' },
        { conversation: 'c-2', sender_type: 'customer', content: 'x'.repeat(50) },
      ]);
    const out = await gateway().listConversationSnippets({ vendorId: 'v-1', snippetChars: 80 });
    expect(out).toEqual([
      { id: 'c-1', text: 'Customer: Refund please / Agent: On it.' },
      { id: 'c-2', text: `Customer: ${'x'.repeat(50)}`.slice(0, 80) },
    ]);
  });

  it('caps the sampled messages per conversation', async () => {
    request.mockResolvedValueOnce([{ id: 'c-1' }]).mockResolvedValueOnce([
      { conversation: 'c-1', sender_type: 'customer', content: 'four' },
      { conversation: 'c-1', sender_type: 'customer', content: 'three' },
      { conversation: 'c-1', sender_type: 'customer', content: 'two' },
      { conversation: 'c-1', sender_type: 'customer', content: 'one' },
    ]);
    const out = await gateway().listConversationSnippets({ messagesPerConversation: 2 });
    expect(out[0]!.text).toBe('Customer: three / Customer: four');
  });

  it('skips conversations with no usable message text', async () => {
    request
      .mockResolvedValueOnce([{ id: 'c-1' }, { id: 'c-2' }])
      .mockResolvedValueOnce([{ conversation: 'c-2', sender_type: 'customer', content: '   ' }]);
    expect(await gateway().listConversationSnippets({})).toEqual([]);
  });

  it('returns [] without a second query when no conversations match', async () => {
    request.mockResolvedValueOnce([]);
    expect(await gateway().listConversationSnippets({ vendorId: 'v-x' })).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('propagates fetch errors so the route can fail soft', async () => {
    request.mockRejectedValueOnce(new Error('directus down'));
    await expect(gateway().listConversationSnippets({})).rejects.toThrow('directus down');
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
