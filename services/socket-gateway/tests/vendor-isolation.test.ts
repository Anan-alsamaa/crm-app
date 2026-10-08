import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { SOCKET_EVENTS } from '@yiji/shared-types';

vi.mock('../src/auth/agent-jwt.js', () => ({
  validateAgentToken: vi.fn(async () => ({ id: 'agent-1', role: 'WeCare Agent' })),
}));

import { registerConnection } from '../src/connection.js';
import type { GatewayDirectus } from '../src/directus.js';
import type { CustomerVerifier } from '../src/auth/customer-jwt.js';
import type { SideEffectProducer } from '../src/queue.js';

/*
 * VENDORS NEVER MIX ON THE WIRE (MV-4, EMA-73).
 *
 * The owner's model: the SAME agents serve every vendor, so an agent socket
 * must hear about every vendor's chats; a CUSTOMER socket must only ever hear
 * about its own conversation (and its own vendor's room). Two customers of two
 * vendors are connected here side by side, with one agent, and every realtime
 * event the gateway emits for one of them is checked against the other.
 */

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

/** Token -> the platform vendor it was minted for. */
const TOKEN_VENDOR: Record<string, string> = { 'tok-a': 'plat-a', 'tok-b': 'plat-b' };
/** Platform vendor -> CRM vendor. */
const CRM_VENDOR: Record<string, string> = { 'plat-a': 'vendor-a', 'plat-b': 'vendor-b' };
/** CRM vendor -> that vendor's customer's live conversation. */
const CONV_OF: Record<string, string> = { 'vendor-a': 'conv-a', 'vendor-b': 'conv-b' };

async function startGateway() {
  let n = 0;
  const directus = {
    resolveVendor: vi.fn(async (plat: string) =>
      CRM_VENDOR[plat] ? { id: CRM_VENDOR[plat], colors: null, name: plat } : null,
    ),
    upsertContact: vi.fn(async (vendorId: string) => ({
      id: `contact-${vendorId}`,
      isNew: false,
      name: null,
      phone: null,
    })),
    findLiveConversation: vi.fn(async (vendorId: string) => ({
      id: CONV_OF[vendorId]!,
      initiatedBy: null,
    })),
    findOrCreateConversation: vi.fn(async (vendorId: string) => ({
      id: CONV_OF[vendorId]!,
      created: false,
    })),
    createWalkInConversation: vi.fn(async () => ({ id: 'conv-walkin', created: true })),
    findResumableConversation: vi.fn(async () => null),
    persistMessage: vi.fn(async () => ({
      id: `msg-${++n}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    deleteInternalNote: vi.fn(async () => true),
    getMessageForEdit: vi.fn(async () => null),
    updateAgentMessage: vi.fn(async () => undefined),
    listAgentConversationIds: vi.fn(async () => []),
    loadConversationMessages: vi.fn(async () => []),
    getConversationStatus: vi.fn(async () => 'open'),
    claimConversationIfUnassigned: vi.fn(async () => true),
    getConversationAttachment: vi.fn(async () => null),
  } as unknown as GatewayDirectus;
  const verifier: CustomerVerifier = {
    verify: vi.fn((token: string) => ({
      vendor_id: TOKEN_VENDOR[token] ?? 'unknown',
      customer_id: `cust-${token}`,
    })),
  } as unknown as CustomerVerifier;
  const producer = {
    conversationCreated: vi.fn(async () => undefined),
    messageReceived: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as SideEffectProducer;

  const http = createServer();
  const io = new SocketServer(http, { cors: { origin: '*' } });
  registerConnection({
    io,
    directus,
    directusUrl: 'http://localhost:8055',
    verifier,
    producer,
    logger: silentLogger,
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        io.close();
        http.close(() => resolve());
      }),
  };
}

const sockets: ClientSocket[] = [];
let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (close) await close();
  close = null;
});

function open(port: number, auth: Record<string, unknown>): ClientSocket {
  const c = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth,
    forceNew: true,
    reconnection: false,
  });
  sockets.push(c);
  return c;
}

function customerReady(port: number, token: string): Promise<ClientSocket> {
  const c = open(port, { kind: 'customer', token, lazyConversation: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ready')), 5000);
    c.once('ready', () => {
      clearTimeout(timer);
      resolve(c);
    });
    c.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function agentConnected(port: number): Promise<ClientSocket> {
  const c = open(port, { kind: 'agent', token: 'good' });
  return new Promise((resolve, reject) => {
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
}

/** Every event a socket receives, by name. */
function record(c: ClientSocket): Array<{ event: string; payload: unknown }> {
  const got: Array<{ event: string; payload: unknown }> = [];
  c.onAny((event: string, payload: unknown) => got.push({ event, payload }));
  return got;
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/** True when anything in `got` names `needle` anywhere in its payload. */
const mentions = (got: Array<{ payload: unknown }>, needle: string) =>
  got.some((g) => JSON.stringify(g.payload ?? null).includes(needle));

describe('realtime vendor isolation (MV-4)', () => {
  it("one agent hears every vendor's chats; a customer never hears another vendor's", async () => {
    const gw = await startGateway();
    close = gw.close;

    const customerB = await customerReady(gw.port, 'tok-b');
    const agent = await agentConnected(gw.port);
    // The agent opens both chats — the same person serves both vendors.
    agent.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId: 'conv-a' });
    agent.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId: 'conv-b' });
    // Customer B tries to listen in on vendor A's chat. Customers may not subscribe.
    customerB.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId: 'conv-a' });
    await settle(50);

    const seenByB = record(customerB);
    const seenByAgent = record(agent);

    // Vendor A's customer arrives (presence) and writes (message + inbox signal).
    const customerA = await customerReady(gw.port, 'tok-a');
    const seenByA = record(customerA);
    customerA.emit(SOCKET_EVENTS.messageSend, { content: 'hello from A', clientMsgId: 'a1' });
    await settle();
    // And an agent reply into A's chat.
    agent.emit(SOCKET_EVENTS.messageSend, {
      conversationId: 'conv-a',
      content: 'reply to A',
      clientMsgId: 'g1',
    });
    await settle();

    // The agent heard vendor A.
    expect(
      seenByAgent.some(
        (g) =>
          g.event === SOCKET_EVENTS.messageNew &&
          (g.payload as { conversationId?: string })?.conversationId === 'conv-a',
      ),
    ).toBe(true);
    expect(seenByAgent.some((g) => g.event === SOCKET_EVENTS.inboxActivity)).toBe(true);

    // Customer B heard NOTHING of vendor A: no message, no inbox signal, no presence.
    expect(seenByB.filter((g) => g.event === SOCKET_EVENTS.messageNew)).toEqual([]);
    expect(seenByB.filter((g) => g.event === SOCKET_EVENTS.inboxActivity)).toEqual([]);
    expect(seenByB.filter((g) => g.event === SOCKET_EVENTS.presenceUpdate)).toEqual([]);
    expect(mentions(seenByB, 'conv-a')).toBe(false);
    expect(mentions(seenByB, 'vendor-a')).toBe(false);
    expect(mentions(seenByB, 'hello from A')).toBe(false);
    expect(mentions(seenByB, 'reply to A')).toBe(false);

    // Now vendor B's customer writes: the agent hears it, customer A does not.
    const before = seenByAgent.length;
    customerB.emit(SOCKET_EVENTS.messageSend, { content: 'hello from B', clientMsgId: 'b1' });
    await settle();
    expect(
      seenByAgent
        .slice(before)
        .some(
          (g) =>
            g.event === SOCKET_EVENTS.messageNew &&
            (g.payload as { conversationId?: string })?.conversationId === 'conv-b',
        ),
    ).toBe(true);
    expect(mentions(seenByA, 'conv-b')).toBe(false);
    expect(mentions(seenByA, 'hello from B')).toBe(false);
    expect(seenByA.filter((g) => g.event === SOCKET_EVENTS.inboxActivity)).toEqual([]);
  });
});
