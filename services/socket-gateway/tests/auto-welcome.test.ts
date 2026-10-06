import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

vi.mock('../src/auth/agent-jwt.js', () => ({ validateAgentToken: vi.fn() }));

import { registerConnection, resetWelcomeCache } from '../src/connection.js';
import type { GatewayDirectus } from '../src/directus.js';

/**
 * THE AUTOMATIC WELCOME (owner, 2026-10-06).
 *
 * After the customer's FIRST message of a session, operations' "رسالة ترحيب"
 * template is sent as a real, persisted, agent-style message with NO
 * `sender_user` — once per session, after the customer's message, never on an
 * agent-initiated chat, and not at all when no template exists. The opening
 * bubble is the widget's own built-in greeting again, so `ready` no longer
 * carries the template.
 */
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

const TEMPLATE =
  'أهلًا وسهلًا بك في مركز خدمة عملاء تطبيق يجي 🌹\n\nWelcome to the Yji App Customer Service Center 👋';

let seq = 0;
function makeDirectus(over: Record<string, unknown> = {}) {
  return {
    resolveVendor: vi.fn(async () => ({ id: 'vendor-uuid', colors: null, name: 'Yiji' })),
    upsertContact: vi.fn(async () => ({ id: 'contact-1', isNew: true, name: null, phone: null })),
    // A brand-new visitor by default: nothing to resume, so the first message creates.
    findLiveConversation: vi.fn(async () => null),
    findOrCreateConversation: vi.fn(async () => ({ id: 'conv-new', created: true })),
    createWalkInConversation: vi.fn(async () => ({ id: 'conv-walkin', created: true })),
    findResumableConversation: vi.fn(async () => null),
    persistMessage: vi.fn(async () => ({
      id: `msg-${++seq}`,
      createdAt: new Date(Date.UTC(2026, 9, 6, 9, 0, seq)).toISOString(),
    })),
    loadConversationMessages: vi.fn(async () => []),
    getConversationStatus: vi.fn(async () => 'open'),
    welcomeTemplates: vi.fn(async () => ({ ar: TEMPLATE, en: null })),
    ...over,
  } as unknown as GatewayDirectus & Record<string, ReturnType<typeof vi.fn>>;
}

let http: HttpServer;
let io: SocketServer;
const sockets: ClientSocket[] = [];

async function start(directus: GatewayDirectus): Promise<number> {
  http = createServer();
  io = new SocketServer(http, { cors: { origin: '*' } });
  registerConnection({
    io,
    directus,
    directusUrl: 'http://localhost:8055',
    verifier: { verify: vi.fn(() => ({ vendor_id: 'yiji-vendor', customer_id: 'cust-1' })) },
    producer: {
      conversationCreated: vi.fn(async () => undefined),
      messageReceived: vi.fn(async () => undefined),
      enqueueRouting: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    logger: silentLogger,
  } as never);
  await new Promise<void>((r) => http.listen(0, r));
  return (http.address() as AddressInfo).port;
}

function customer(
  port: number,
  auth: Record<string, unknown> = {},
): Promise<{
  client: ClientSocket;
  ready: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
}> {
  const client = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { kind: 'customer', token: 't', lazyConversation: true, ...auth },
    forceNew: true,
    reconnection: false,
  });
  sockets.push(client);
  const messages: Array<Record<string, unknown>> = [];
  client.on('message:new', (m: Record<string, unknown>) => messages.push(m));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ready')), 5000);
    client.once('ready', (ready: Record<string, unknown>) => {
      clearTimeout(t);
      resolve({ client, ready, messages });
    });
  });
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

beforeEach(() => {
  resetWelcomeCache();
  seq = 0;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  io?.close();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
});

describe('the automatic welcome', () => {
  it('ready no longer carries the template — the widget opens with its built-in greeting', async () => {
    const { ready } = await customer(await start(makeDirectus()));
    expect(ready).not.toHaveProperty('welcome');
  });

  it("follows the customer's first message, as an agent message with no sender_user", async () => {
    const directus = makeDirectus();
    const { client, messages } = await customer(await start(directus));
    client.emit('message:send', { content: 'وين طلبي؟', clientMsgId: 'a' });
    await until(() => messages.length >= 2);

    const calls = directus.persistMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls[0]).toMatchObject({ senderType: 'customer', content: 'وين طلبي؟' });
    expect(calls[1]).toMatchObject({ senderType: 'agent', content: TEMPLATE });
    expect(calls[1]!.senderUser).toBeUndefined();

    // Order on screen: the question, THEN the welcome.
    expect(messages[0]).toMatchObject({ senderType: 'customer' });
    expect(messages[1]).toMatchObject({ senderType: 'agent', content: TEMPLATE, automated: true });
    expect(messages[1]).not.toHaveProperty('senderUserId');
  });

  it('is sent ONCE per session, not on every message', async () => {
    const directus = makeDirectus();
    const { client, messages } = await customer(await start(directus));
    client.emit('message:send', { content: 'hello', clientMsgId: 'a' });
    await until(() => messages.length >= 2);
    client.emit('message:send', { content: 'anyone?', clientMsgId: 'b' });
    await until(() => messages.length >= 3);
    await settle();
    const agentWrites = directus.persistMessage.mock.calls.filter(
      (c) => (c[0] as { senderType: string }).senderType === 'agent',
    );
    expect(agentWrites).toHaveLength(1);
  });

  /* A reconnect resumes the thread rather than creating it: no second welcome. */
  it('is not sent when the socket resumes an existing live thread', async () => {
    const directus = makeDirectus({
      findLiveConversation: vi.fn(async () => ({ id: 'conv-1', initiatedBy: null })),
    });
    const { client, messages } = await customer(await start(directus));
    client.emit('message:send', { content: 'back again', clientMsgId: 'a' });
    await until(() => messages.length >= 1);
    await settle();
    expect(directus.persistMessage).toHaveBeenCalledTimes(1);
  });

  /* "A reopened chat is a NEW session": persistMessage reports it. */
  it('is sent when the message reopens a solved chat (a new session)', async () => {
    const directus = makeDirectus({
      findLiveConversation: vi.fn(async () => ({ id: 'conv-1', initiatedBy: null })),
      persistMessage: vi.fn(async (input: { senderType: string }) => ({
        id: `msg-${++seq}`,
        createdAt: new Date().toISOString(),
        ...(input.senderType === 'customer' ? { sessionStarted: true } : {}),
      })),
    });
    const { client, messages } = await customer(await start(directus));
    client.emit('message:send', { content: 'hi again', clientMsgId: 'a' });
    await until(() => messages.length >= 2);
    expect(messages[1]).toMatchObject({ senderType: 'agent', automated: true });
  });

  /* No row, inactive row (filtered out by the query), failed read: send nothing. */
  it.each([
    ['no template row', async () => ({ ar: null, en: null })],
    [
      'a failed read',
      async () => {
        throw new Error('403');
      },
    ],
  ])('sends nothing with %s', async (_label, impl) => {
    const directus = makeDirectus({ welcomeTemplates: vi.fn(impl) });
    const { client, messages } = await customer(await start(directus));
    client.emit('message:send', { content: 'hello', clientMsgId: 'a' });
    await until(() => messages.length >= 1);
    await settle();
    expect(directus.persistMessage).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
  });

  it('substitutes the customer name, and removes {name} cleanly without one', async () => {
    const named = makeDirectus({
      upsertContact: vi.fn(async () => ({ id: 'c', isNew: false, name: 'Ayman', phone: null })),
      welcomeTemplates: vi.fn(async () => ({ ar: null, en: 'Welcome {name}, how can we help?' })),
    });
    const a = await customer(await start(named));
    a.client.emit('message:send', { content: 'hello', clientMsgId: 'a' });
    await until(() => a.messages.length >= 2);
    expect(a.messages[1]!.content).toBe('Welcome Ayman, how can we help?');
  });
});
