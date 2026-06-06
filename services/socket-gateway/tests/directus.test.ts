import { describe, it, expect, vi, beforeEach } from 'vitest';

// GatewayDirectus is a thin wrapper around a Directus service client. We mock
// the client factory so `request()` returns canned rows in call order and we
// can assert the persistence logic (dedup, resume-or-create, note guard).
const request = vi.fn();
vi.mock('@yiji/shared-config', () => ({
  createServiceClient: () => ({ request }),
}));

import { GatewayDirectus } from '../src/directus.js';
import type { CustomerClaims } from '../src/auth/customer-jwt.js';

function makeGateway(): GatewayDirectus {
  return new GatewayDirectus('http://localhost:8055', 'svc-token');
}

const baseClaims: CustomerClaims = {
  vendor_id: 'yiji-v',
  customer_id: 'ext-1',
  email: 'demo@example.com',
  phone: '+15550001',
  name: 'Demo',
};

beforeEach(() => {
  request.mockReset();
});

describe('GatewayDirectus.resolveVendor', () => {
  it('returns the first active vendor row', async () => {
    request.mockResolvedValueOnce([{ id: 'vendor-uuid', colors: { primary: '#fff' } }]);
    const vendor = await makeGateway().resolveVendor('yiji-v');
    expect(vendor).toEqual({ id: 'vendor-uuid', colors: { primary: '#fff' } });
  });

  it('returns null when no active vendor matches', async () => {
    request.mockResolvedValueOnce([]);
    expect(await makeGateway().resolveVendor('missing')).toBeNull();
  });
});

describe('GatewayDirectus.upsertContact', () => {
  it('returns the existing contact id when one matches phone/email', async () => {
    request.mockResolvedValueOnce([{ id: 'contact-existing' }]);
    const id = await makeGateway().upsertContact('vendor-uuid', baseClaims);
    expect(id).toBe('contact-existing');
    expect(request).toHaveBeenCalledTimes(1); // no create call
  });

  it('creates a new contact when none exists', async () => {
    request
      .mockResolvedValueOnce([]) // lookup miss
      .mockResolvedValueOnce({ id: 'contact-new' }); // create
    const id = await makeGateway().upsertContact('vendor-uuid', baseClaims);
    expect(id).toBe('contact-new');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('still creates a contact when claims carry only an email', async () => {
    request.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'c2' });
    const id = await makeGateway().upsertContact('vendor-uuid', {
      vendor_id: 'yiji-v',
      customer_id: 'ext-2',
      email: 'only@example.com',
    });
    expect(id).toBe('c2');
  });

  it('recovers from a concurrent-create unique violation by re-querying', async () => {
    request
      .mockResolvedValueOnce([]) // lookup miss
      .mockRejectedValueOnce({
        errors: [
          { message: 'Value for field "vendor, phone" in collection "contacts" has to be unique.' },
        ],
      }) // create loses the race
      .mockResolvedValueOnce([{ id: 'contact-raced' }]); // re-query finds the winner's row
    const id = await makeGateway().upsertContact('vendor-uuid', baseClaims);
    expect(id).toBe('contact-raced');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rethrows a create failure that is not a lost race', async () => {
    request
      .mockResolvedValueOnce([]) // lookup miss
      .mockRejectedValueOnce(new Error('db exploded')) // create fails for real
      .mockResolvedValueOnce([]); // re-query still finds nothing
    await expect(makeGateway().upsertContact('vendor-uuid', baseClaims)).rejects.toThrow(
      'db exploded',
    );
  });
});

describe('GatewayDirectus.findOrCreateConversation', () => {
  it('resumes the open conversation when one exists', async () => {
    request.mockResolvedValueOnce([{ id: 'conv-open' }]);
    const id = await makeGateway().findOrCreateConversation('vendor-uuid', 'contact-1');
    expect(id).toBe('conv-open');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('creates a new conversation when none is open', async () => {
    request.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'conv-new' });
    const id = await makeGateway().findOrCreateConversation('vendor-uuid', 'contact-1');
    expect(id).toBe('conv-new');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('GatewayDirectus.persistMessage', () => {
  it('creates the message then bumps last_message_at', async () => {
    request
      .mockResolvedValueOnce({ id: 'msg-1' }) // createItem(messages)
      .mockResolvedValueOnce(undefined); // updateItem(conversations)
    const saved = await makeGateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'agent',
      senderUser: 'agent-1',
      content: 'hi',
    });
    expect(saved.id).toBe('msg-1');
    expect(typeof saved.createdAt).toBe('string');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('GatewayDirectus.deleteInternalNote', () => {
  it('deletes when the row is an internal note in the conversation', async () => {
    request
      .mockResolvedValueOnce([{ id: 'm-1', is_internal_note: true }]) // read
      .mockResolvedValueOnce(undefined); // delete
    expect(await makeGateway().deleteInternalNote('conv-1', 'm-1')).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses to delete a non-note message (no delete call)', async () => {
    request.mockResolvedValueOnce([{ id: 'm-1', is_internal_note: false }]);
    expect(await makeGateway().deleteInternalNote('conv-1', 'm-1')).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns false when the message is not found', async () => {
    request.mockResolvedValueOnce([]);
    expect(await makeGateway().deleteInternalNote('conv-1', 'absent')).toBe(false);
  });
});

describe('GatewayDirectus.listAgentConversationIds', () => {
  it('maps rows to a flat id array', async () => {
    request.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    expect(await makeGateway().listAgentConversationIds('agent-1')).toEqual(['a', 'b']);
  });
});
