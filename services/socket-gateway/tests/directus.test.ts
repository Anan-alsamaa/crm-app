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
  it('resumes the existing contact (isNew:false) with its STORED name', async () => {
    request.mockResolvedValueOnce([
      { id: 'contact-existing', name: 'Stored Name', phone: '+15550001' },
    ]);
    const res = await makeGateway().upsertContact('vendor-uuid', baseClaims);
    expect(res).toEqual({
      id: 'contact-existing',
      isNew: false,
      name: 'Stored Name',
      phone: '+15550001',
    });
    expect(request).toHaveBeenCalledTimes(1); // no create call
  });

  it('creates a new contact (isNew:true) when none exists', async () => {
    request
      .mockResolvedValueOnce([]) // lookup miss
      .mockResolvedValueOnce({ id: 'contact-new' }); // create
    const res = await makeGateway().upsertContact('vendor-uuid', baseClaims);
    expect(res).toEqual({ id: 'contact-new', isNew: true, name: 'Demo', phone: '+15550001' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('still creates a contact when claims carry only an email', async () => {
    request.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'c2' });
    const res = await makeGateway().upsertContact('vendor-uuid', {
      vendor_id: 'yiji-v',
      customer_id: 'ext-2',
      email: 'only@example.com',
    });
    expect(res).toEqual({ id: 'c2', isNew: true, name: null, phone: null });
  });

  it('recovers from a concurrent-create unique violation by re-querying', async () => {
    request
      .mockResolvedValueOnce([]) // lookup miss
      .mockRejectedValueOnce({
        errors: [
          { message: 'Value for field "vendor, phone" in collection "contacts" has to be unique.' },
        ],
      }) // create loses the race
      .mockResolvedValueOnce([{ id: 'contact-raced', name: null, phone: '+15550001' }]); // re-query finds the winner
    const res = await makeGateway().upsertContact('vendor-uuid', baseClaims);
    expect(res.id).toBe('contact-raced');
    expect(res.isNew).toBe(false);
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

/**
 * Directus SDK commands are thunks resolving to {path, params, body, method},
 * so a canned `request` mock can be inspected for what would have been sent.
 */
async function sentAt(call: number): Promise<{
  params: Record<string, unknown>;
  body: Record<string, unknown>;
}> {
  const cmd = request.mock.calls[call]![0] as (c: unknown) => Promise<{
    params?: Record<string, unknown>;
    body?: string;
  }>;
  const out = await cmd({ globals: {} });
  return {
    params: out.params ?? {},
    body: out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {},
  };
}

describe('GatewayDirectus.findOrCreateConversation', () => {
  it('resumes the open conversation (created:false) when one exists', async () => {
    request.mockResolvedValueOnce([{ id: 'conv-open' }]);
    const res = await makeGateway().findOrCreateConversation('vendor-uuid', 'contact-1');
    expect(res).toEqual({ id: 'conv-open', created: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('creates a new conversation (created:true) when none is open', async () => {
    request.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'conv-new' });
    const res = await makeGateway().findOrCreateConversation('vendor-uuid', 'contact-1');
    expect(res).toEqual({ id: 'conv-new', created: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('counts PENDING as live, so parking a case does not split the thread', async () => {
    request.mockResolvedValueOnce([{ id: 'conv-pending' }]);
    await makeGateway().findOrCreateConversation('vendor-uuid', 'contact-1');
    const { params } = await sentAt(0);
    expect(params.filter).toMatchObject({ status: { _in: ['open', 'pending'] } });
  });

  it('does not resume a solved thread — a later message is a new case', async () => {
    // Only open/pending are matched, so a resolved/closed thread falls through
    // to the create branch and the customer gets a fresh conversation.
    request.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'conv-fresh' });
    const res = await makeGateway().findOrCreateConversation('vendor-uuid', 'contact-1');
    expect(res).toEqual({ id: 'conv-fresh', created: true });
    expect((await sentAt(1)).body).toMatchObject({ status: 'open' });
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

  it('reopens a solved conversation when the customer writes into it', async () => {
    request
      .mockResolvedValueOnce({ id: 'msg-9' }) // createItem(messages)
      .mockResolvedValueOnce([{ unread_count_agent: 2, status: 'resolved' }]) // read
      .mockResolvedValueOnce(undefined); // updateItem(conversations)
    await makeGateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'customer',
      senderContact: 'contact-1',
      content: 'my order never arrived',
    });
    const { body } = await sentAt(2);
    // Back into the agent's queue, and the unread bookkeeping still runs.
    expect(body).toMatchObject({ status: 'pending', unread_count_agent: 3 });
  });

  it('leaves the status alone when the conversation is already live', async () => {
    request
      .mockResolvedValueOnce({ id: 'msg-10' })
      .mockResolvedValueOnce([{ unread_count_agent: 0, status: 'open' }])
      .mockResolvedValueOnce(undefined);
    await makeGateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'customer',
      senderContact: 'contact-1',
      content: 'still there?',
    });
    const { body } = await sentAt(2);
    expect(body.status).toBeUndefined();
    expect(body).toMatchObject({ unread_count_agent: 1 });
  });

  it('never reopens on an agent reply', async () => {
    request.mockResolvedValueOnce({ id: 'msg-11' }).mockResolvedValueOnce(undefined);
    await makeGateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'agent',
      senderUser: 'agent-1',
      content: 'sorted for you',
    });
    // Agent branch does not even read the conversation back.
    expect(request).toHaveBeenCalledTimes(2);
    const { body } = await sentAt(1);
    expect(body.status).toBeUndefined();
  });

  it('an internal note touches neither status nor unread count', async () => {
    request.mockResolvedValueOnce({ id: 'msg-12' }).mockResolvedValueOnce(undefined);
    await makeGateway().persistMessage({
      conversationId: 'conv-1',
      senderType: 'agent',
      senderUser: 'agent-1',
      content: 'chasing the restaurant',
      isInternalNote: true,
    });
    const { body } = await sentAt(1);
    expect(body.status).toBeUndefined();
    expect(body.unread_count_agent).toBeUndefined();
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

describe('GatewayDirectus.loadConversationMessages', () => {
  it('returns visible messages with attachment ids grouped from the junction', async () => {
    request
      .mockResolvedValueOnce([
        {
          id: 'm1',
          sender_type: 'customer',
          content: 'hi',
          date_created: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'm2',
          sender_type: 'agent',
          content: 'hello',
          date_created: '2026-01-01T00:01:00.000Z',
        },
      ]) // messages
      .mockResolvedValueOnce([
        { messages_id: 'm1', directus_files_id: 'f1' },
        { messages_id: 'm1', directus_files_id: 'f2' },
      ]); // messages_files junction
    const msgs = await makeGateway().loadConversationMessages('conv-1');
    expect(msgs).toEqual([
      {
        id: 'm1',
        senderType: 'customer',
        content: 'hi',
        createdAt: '2026-01-01T00:00:00.000Z',
        attachments: ['f1', 'f2'],
      },
      {
        id: 'm2',
        senderType: 'agent',
        content: 'hello',
        createdAt: '2026-01-01T00:01:00.000Z',
        attachments: [],
      },
    ]);
  });

  it('short-circuits (no junction read) when there are no messages', async () => {
    request.mockResolvedValueOnce([]);
    expect(await makeGateway().loadConversationMessages('conv-1')).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('GatewayDirectus.getConversationAttachment', () => {
  it('returns null (no meta read, no asset fetch) when the file is not in the conversation', async () => {
    request.mockResolvedValueOnce([]); // authorization lookup miss
    expect(await makeGateway().getConversationAttachment('conv-1', 'f-x')).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('GatewayDirectus.getAssignmentTarget', () => {
  it('reads a ticket assignee + subject with the SERVICE token', async () => {
    request.mockResolvedValueOnce([{ id: 'tkt-1', assigned_agent: 'agent-2', subject: 'Refund' }]);
    expect(await makeGateway().getAssignmentTarget('ticket', 'tkt-1')).toEqual({
      id: 'tkt-1',
      assignedAgent: 'agent-2',
      label: 'Refund',
    });
  });

  it('reads a conversation assignee and uses the contact name as the label', async () => {
    request.mockResolvedValueOnce([
      { id: 'conv-1', assigned_agent: 'agent-3', contact: { name: 'Dana' } },
    ]);
    expect(await makeGateway().getAssignmentTarget('conversation', 'conv-1')).toEqual({
      id: 'conv-1',
      assignedAgent: 'agent-3',
      label: 'Dana',
    });
  });

  it('normalises a missing assignee/contact to null', async () => {
    request.mockResolvedValueOnce([{ id: 'conv-2', assigned_agent: null, contact: null }]);
    expect(await makeGateway().getAssignmentTarget('conversation', 'conv-2')).toEqual({
      id: 'conv-2',
      assignedAgent: null,
      label: null,
    });
  });

  it('returns null when the entity does not exist', async () => {
    request.mockResolvedValueOnce([]);
    expect(await makeGateway().getAssignmentTarget('ticket', 'nope')).toBeNull();
  });
});
