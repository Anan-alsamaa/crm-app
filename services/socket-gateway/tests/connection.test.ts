import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { SOCKET_EVENTS, rooms } from '@yiji/shared-types';

// validateAgentToken is imported directly by connection.ts (not injected), so
// we mock the module. Every other dependency (directus, verifier, producer) is
// injected and can be stubbed per-test.
vi.mock('../src/auth/agent-jwt.js', () => ({
  validateAgentToken: vi.fn(),
}));

import { validateAgentToken } from '../src/auth/agent-jwt.js';
import { registerConnection } from '../src/connection.js';
import type { GatewayDirectus } from '../src/directus.js';
import type { CustomerVerifier } from '../src/auth/customer-jwt.js';
import { CustomerTokenError } from '../src/auth/customer-jwt.js';
import type { SideEffectProducer } from '../src/queue.js';

const mockedValidateAgentToken = vi.mocked(validateAgentToken);

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

interface Stubs {
  directus: GatewayDirectus;
  verifier: CustomerVerifier;
  producer: SideEffectProducer & {
    conversationCreated: ReturnType<typeof vi.fn>;
    messageReceived: ReturnType<typeof vi.fn>;
  };
}

function makeStubs(over: Partial<Record<keyof GatewayDirectus, unknown>> = {}): Stubs {
  const directus = {
    resolveVendor: vi.fn(async () => ({ id: 'vendor-uuid', colors: { primary: '#abcabc' } })),
    upsertContact: vi.fn(async () => ({ id: 'contact-1', isNew: true, name: null, phone: null })),
    findOrCreateConversation: vi.fn(async () => ({ id: 'conv-1', created: true })),
    persistMessage: vi.fn(async () => ({ id: 'msg-1', createdAt: '2026-01-01T00:00:00.000Z' })),
    deleteInternalNote: vi.fn(async () => true),
    listAgentConversationIds: vi.fn(async () => ['conv-1']),
    loadConversationMessages: vi.fn(async () => []),
    getConversationStatus: vi.fn(async () => 'open'),
    getConversationAttachment: vi.fn(async () => null),
    ...over,
  } as unknown as GatewayDirectus;

  const verifier: CustomerVerifier = {
    verify: vi.fn(() => ({ vendor_id: 'yiji-vendor', customer_id: 'cust-1', email: 'a@b.com' })),
  };

  const producer = {
    conversationCreated: vi.fn(async () => undefined),
    messageReceived: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  return { directus, verifier, producer };
}

interface Harness {
  port: number;
  io: SocketServer;
  http: HttpServer;
  stubs: Stubs;
  close: () => Promise<void>;
}

async function startGateway(stubs: Stubs): Promise<Harness> {
  const http = createServer();
  const io = new SocketServer(http, { cors: { origin: '*' } });
  registerConnection({
    io,
    directus: stubs.directus,
    directusUrl: 'http://localhost:8055',
    verifier: stubs.verifier,
    producer: stubs.producer,
    logger: silentLogger,
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    io,
    http,
    stubs,
    close: () =>
      new Promise<void>((resolve) => {
        io.close();
        http.close(() => resolve());
      }),
  };
}

/** Create a client socket without awaiting connection (listeners can be
 * attached synchronously before the server starts emitting). */
function openClient(port: number, auth: Record<string, unknown>): ClientSocket {
  return ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth,
    forceNew: true,
    reconnection: false,
  });
}

function connect(port: number, auth: Record<string, unknown>): Promise<ClientSocket> {
  const client = openClient(port, auth);
  return new Promise((resolve, reject) => {
    client.on('connect', () => resolve(client));
    client.on('connect_error', (err) => reject(err));
  });
}

/** Open a customer client and resolve once it has received its `ready` frame.
 * Attaches the `ready` listener before connecting to avoid missing it. */
function connectCustomerReady(port: number, sockets: ClientSocket[]): Promise<ClientSocket> {
  const client = openClient(port, { kind: 'customer', token: 't' });
  sockets.push(client);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ready')), 5000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolve with the first payload of `event`, or reject after `ms`. */
function waitFor<T = unknown>(client: ClientSocket, event: string, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('socket-gateway connection handler (mocked Directus)', () => {
  let harness: Harness;
  const sockets: ClientSocket[] = [];

  beforeEach(() => {
    mockedValidateAgentToken.mockReset();
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    if (harness) await harness.close();
  });

  describe('customer auth + onboarding', () => {
    it('onboards a customer and emits ready with conversation + branding', async () => {
      harness = await startGateway(makeStubs());
      const readyPayloads: Array<{
        conversationId: string;
        branding: unknown;
        agentsOnline: number;
      }> = [];
      const client = openClient(harness.port, { kind: 'customer', token: 't' });
      sockets.push(client);
      const readyP = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for ready')), 5000);
        client.once('ready', (p) => {
          clearTimeout(timer);
          readyPayloads.push(p);
          resolve();
        });
      });
      await readyP;
      const ready = readyPayloads[0]!;

      expect(ready.conversationId).toBe('conv-1');
      expect(ready.branding).toEqual({ primary: '#abcabc' });
      expect(typeof ready.agentsOnline).toBe('number');
      expect(harness.stubs.directus.resolveVendor).toHaveBeenCalledWith('yiji-vendor');
      expect(harness.stubs.directus.upsertContact).toHaveBeenCalledWith(
        'vendor-uuid',
        expect.objectContaining({ customer_id: 'cust-1' }),
      );
      expect(harness.stubs.directus.findOrCreateConversation).toHaveBeenCalledWith(
        'vendor-uuid',
        'contact-1',
      );
    });

    it('seeds a returning customer with messages:history', async () => {
      harness = await startGateway(
        makeStubs({
          loadConversationMessages: vi.fn(async () => [
            {
              id: 'm1',
              senderType: 'customer',
              content: 'earlier message',
              createdAt: '2026-01-01T00:00:00.000Z',
              attachments: [],
            },
          ]),
        }),
      );
      const client = openClient(harness.port, { kind: 'customer', token: 't' });
      sockets.push(client);
      const history = await waitFor<{ conversationId: string; messages: Array<{ id: string }> }>(
        client,
        'messages:history',
      );
      expect(history.conversationId).toBe('conv-1');
      expect(history.messages[0]!.id).toBe('m1');
    });

    it('rejects a customer when the vendor is unknown/inactive', async () => {
      harness = await startGateway(makeStubs({ resolveVendor: vi.fn(async () => null) }));
      await expect(connect(harness.port, { kind: 'customer', token: 't' })).rejects.toThrow(
        /unknown or inactive vendor/,
      );
    });

    it('rejects a customer with a missing token', async () => {
      harness = await startGateway(makeStubs());
      await expect(connect(harness.port, { kind: 'customer' })).rejects.toThrow(/missing token/);
    });

    it('rejects a customer when the verifier throws', async () => {
      const stubs = makeStubs();
      (stubs.verifier.verify as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new CustomerTokenError('token invalid');
      });
      harness = await startGateway(stubs);
      await expect(connect(harness.port, { kind: 'customer', token: 'bad' })).rejects.toThrow(
        /token invalid/,
      );
    });
  });

  describe('agent auth + onboarding', () => {
    it('rejects an agent with a missing token', async () => {
      harness = await startGateway(makeStubs());
      await expect(connect(harness.port, { kind: 'agent' })).rejects.toThrow(/missing token/);
    });

    it('rejects an agent when the token is invalid', async () => {
      mockedValidateAgentToken.mockResolvedValue(null);
      harness = await startGateway(makeStubs());
      await expect(connect(harness.port, { kind: 'agent', token: 'nope' })).rejects.toThrow(
        /invalid agent token/,
      );
    });

    it('onboards an agent and joins their assigned conversation rooms', async () => {
      mockedValidateAgentToken.mockResolvedValue({ id: 'agent-1', role: 'agent' });
      harness = await startGateway(makeStubs());
      const client = await connect(harness.port, { kind: 'agent', token: 'good' });
      sockets.push(client);
      // Give the async onAgentConnect joins a tick to settle.
      await new Promise((r) => setTimeout(r, 30));
      expect(harness.stubs.directus.listAgentConversationIds).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('message + note + signal handlers', () => {
    async function connectedAgent(): Promise<ClientSocket> {
      mockedValidateAgentToken.mockResolvedValue({ id: 'agent-1', role: 'agent' });
      const client = await connect(harness.port, { kind: 'agent', token: 'good' });
      sockets.push(client);
      await new Promise((r) => setTimeout(r, 30));
      return client;
    }

    it('message:send persists and broadcasts message:new + producer side-effect', async () => {
      harness = await startGateway(makeStubs());
      const agent = await connectedAgent();

      const got = waitFor<{ id: string; conversationId: string; senderType: string }>(
        agent,
        SOCKET_EVENTS.messageNew,
      );
      agent.emit(SOCKET_EVENTS.messageSend, {
        conversationId: 'conv-1',
        content: 'hello world',
        clientMsgId: 'c-1',
      });

      const msg = await got;
      expect(msg.id).toBe('msg-1');
      expect(msg.senderType).toBe('agent');
      expect(harness.stubs.directus.persistMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1', content: 'hello world' }),
      );
      await new Promise((r) => setTimeout(r, 20));
      // The gateway forwards the message content too (for keyword automation).
      expect(harness.stubs.producer.messageReceived).toHaveBeenCalledWith('conv-1', 'hello world');
    });

    it('message:send with a bad payload emits a bad_payload error', async () => {
      harness = await startGateway(makeStubs());
      const agent = await connectedAgent();
      const err = waitFor<{ code: string }>(agent, SOCKET_EVENTS.error);
      agent.emit(SOCKET_EVENTS.messageSend, { content: '' });
      expect((await err).code).toBe('bad_payload');
    });

    it('message:send emits persist_failed when Directus throws', async () => {
      harness = await startGateway(
        makeStubs({
          persistMessage: vi.fn(async () => {
            throw new Error('db down');
          }),
        }),
      );
      const agent = await connectedAgent();
      const err = waitFor<{ code: string }>(agent, SOCKET_EVENTS.error);
      agent.emit(SOCKET_EVENTS.messageSend, {
        conversationId: 'conv-1',
        content: 'x',
        clientMsgId: 'm',
      });
      expect((await err).code).toBe('persist_failed');
    });

    it('message:send from a customer is REJECTED when targeting another conversation (IDOR)', async () => {
      // A customer socket is bound to conv-1 at handshake (stub returns conv-1).
      // Emitting with a different conversationId must be refused, not persisted —
      // otherwise it is cross-tenant message injection.
      harness = await startGateway(makeStubs());
      const customer = await connectCustomerReady(harness.port, sockets);
      const err = waitFor<{ code: string }>(customer, SOCKET_EVENTS.error);
      customer.emit(SOCKET_EVENTS.messageSend, {
        conversationId: 'conv-SOMEONE-ELSE',
        content: 'cross-tenant attempt',
        clientMsgId: 'x',
      });
      expect((await err).code).toBe('forbidden');
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.stubs.directus.persistMessage).not.toHaveBeenCalled();
    });

    it('message:send from a customer into its OWN conversation still persists', async () => {
      harness = await startGateway(makeStubs());
      const customer = await connectCustomerReady(harness.port, sockets);
      const got = waitFor<{ id: string }>(customer, SOCKET_EVENTS.messageNew);
      customer.emit(SOCKET_EVENTS.messageSend, {
        conversationId: 'conv-1',
        content: 'legit message',
        clientMsgId: 'ok',
      });
      await got;
      expect(harness.stubs.directus.persistMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1', senderType: 'customer' }),
      );
    });

    it('note:add (agent) broadcasts note:new', async () => {
      harness = await startGateway(makeStubs());
      const agent = await connectedAgent();
      const got = waitFor<{ id: string; isInternalNote: boolean }>(agent, SOCKET_EVENTS.noteNew);
      agent.emit(SOCKET_EVENTS.noteAdd, {
        conversationId: 'conv-1',
        content: 'internal note',
        clientMsgId: 'n-1',
      });
      const note = await got;
      expect(note.isInternalNote).toBe(true);
      expect(harness.stubs.directus.persistMessage).toHaveBeenCalledWith(
        expect.objectContaining({ isInternalNote: true }),
      );
    });

    it('note:delete (agent) broadcasts note:deleted', async () => {
      harness = await startGateway(makeStubs());
      const agent = await connectedAgent();
      const got = waitFor<{ noteId: string }>(agent, SOCKET_EVENTS.noteDeleted);
      agent.emit(SOCKET_EVENTS.noteDelete, { conversationId: 'conv-1', noteId: 'msg-1' });
      expect((await got).noteId).toBe('msg-1');
    });

    it('note:delete emits note_delete_rejected when not an internal note', async () => {
      harness = await startGateway(makeStubs({ deleteInternalNote: vi.fn(async () => false) }));
      const agent = await connectedAgent();
      const err = waitFor<{ code: string }>(agent, SOCKET_EVENTS.error);
      agent.emit(SOCKET_EVENTS.noteDelete, { conversationId: 'conv-1', noteId: 'msg-1' });
      expect((await err).code).toBe('note_delete_rejected');
    });

    it('note:delete emits note_delete_failed when Directus throws', async () => {
      harness = await startGateway(
        makeStubs({
          deleteInternalNote: vi.fn(async () => {
            throw new Error('no permission');
          }),
        }),
      );
      const agent = await connectedAgent();
      const err = waitFor<{ code: string }>(agent, SOCKET_EVENTS.error);
      agent.emit(SOCKET_EVENTS.noteDelete, { conversationId: 'conv-1', noteId: 'msg-1' });
      expect((await err).code).toBe('note_delete_failed');
    });

    it('conversation:updated fans out inbox:activity to agents', async () => {
      harness = await startGateway(makeStubs());
      const a1 = await connectedAgent();
      const a2 = await connectedAgent();
      const got = waitFor<{ conversationId: string }>(a2, SOCKET_EVENTS.inboxActivity);
      a1.emit(SOCKET_EVENTS.conversationUpdated, { conversationId: 'conv-99' });
      expect((await got).conversationId).toBe('conv-99');
    });

    it('conversation:updated that closes a conversation notifies the customer (CSAT)', async () => {
      harness = await startGateway(
        makeStubs({ getConversationStatus: vi.fn(async () => 'closed') }),
      );
      const customer = await connectCustomerReady(harness.port, sockets); // joins conv-1
      const agent = await connectedAgent();
      const closed = waitFor<{ conversationId: string; status: string }>(
        customer,
        'conversation:closed',
      );
      agent.emit(SOCKET_EVENTS.conversationUpdated, { conversationId: 'conv-1' });
      const evt = await closed;
      expect(evt.conversationId).toBe('conv-1');
      expect(evt.status).toBe('closed');
    });
  });

  describe('typing + read signals between two parties', () => {
    it('typing:start from one socket reaches the other in the same conversation', async () => {
      harness = await startGateway(makeStubs());
      // two customers land in the same conversation (conv-1) per the stub
      const c1 = await connectCustomerReady(harness.port, sockets);
      const c2 = await connectCustomerReady(harness.port, sockets);

      const got = waitFor<{ isTyping: boolean }>(c2, SOCKET_EVENTS.typingUpdate);
      c1.emit(SOCKET_EVENTS.typingStart, { conversationId: 'conv-1' });
      expect((await got).isTyping).toBe(true);
    });

    it('read:ack is forwarded to the rest of the conversation room', async () => {
      harness = await startGateway(makeStubs());
      const c1 = await connectCustomerReady(harness.port, sockets);
      const c2 = await connectCustomerReady(harness.port, sockets);

      const got = waitFor<{ conversationId: string }>(c2, SOCKET_EVENTS.readAck);
      c1.emit(SOCKET_EVENTS.readAck, { conversationId: 'conv-1', lastMessageId: 'msg-1' });
      expect((await got).conversationId).toBe('conv-1');
    });
  });

  describe('presence broadcasts', () => {
    it('emits agents:presence with a numeric count when an agent connects', async () => {
      harness = await startGateway(makeStubs());
      // A customer is a stable observer of the global agents:presence pulse.
      const observer = await connectCustomerReady(harness.port, sockets);

      const presence = waitFor<{ count: number }>(observer, SOCKET_EVENTS.agentsPresence);
      mockedValidateAgentToken.mockResolvedValue({ id: 'agent-presence-1', role: 'agent' });
      const agent = await connect(harness.port, { kind: 'agent', token: 'good' });
      sockets.push(agent);
      expect((await presence).count).toBeGreaterThanOrEqual(1);
    });

    it('updates customer presence list on connect', async () => {
      harness = await startGateway(makeStubs());
      const c1 = await connectCustomerReady(harness.port, sockets);

      const update = waitFor<{ vendorId: string; online: string[] }>(
        c1,
        SOCKET_EVENTS.presenceUpdate,
      );
      const c2 = openClient(harness.port, { kind: 'customer', token: 't' });
      sockets.push(c2);
      const payload = await update;
      expect(payload.vendorId).toBe('vendor-uuid');
      expect(payload.online.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('exposes namespaced rooms used by the handlers', () => {
    expect(rooms.conversation('conv-1')).toBe('conversation:conv-1');
    expect(rooms.agentsAll()).toBeTypeOf('string');
  });
});
