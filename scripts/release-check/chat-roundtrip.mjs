#!/usr/bin/env node
/**
 * RELEASE CHECK — the chat, exercised end to end the way people use it.
 *
 * Owner rule (2026-10-06): every release must prove that chats work, that
 * attachments go both ways, and that previously solved bugs have not come back
 * — even when the release did not touch that area. "4/4 digest-verified" only
 * proves the images shipped; this proves the PRODUCT works.
 *
 * It plays both sides with real sockets and real HTTP:
 *   customer session → customer sends text → agent receives it
 *   agent replies → customer receives it
 *   agent edits / deletes the reply → customer sees it live (EMA-33)
 *   customer uploads a photo exactly as a browser does: CORS preflight first,
 *   then POST /chat/attachment, then sends it → agent receives it and can open
 *   the file (EMA-50 — photos were refused at the preflight, twice)
 *
 * Usage:
 *   API=https://crm-api-staging.anan.sa ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *   WIDGET_ORIGIN=https://crm-staging.anan.sa CHECK_PHONE=05XXXXXXXX \
 *   node scripts/release-check/chat-roundtrip.mjs
 *
 * Exit 0 only if every step passed. Each step prints PASS/FAIL with a reason.
 * It WRITES one test conversation (customer CHECK_PHONE) and closes it at the
 * end; on production that number must be the dedicated release-check contact.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { io } = createRequire(join(ROOT, 'apps/chat-widget/package.json'))('socket.io-client');

const API = (process.env.API ?? '').replace(/\/$/, '');
const ORIGIN = process.env.WIDGET_ORIGIN ?? '';
const PHONE = process.env.CHECK_PHONE ?? '';
if (!API || !ORIGIN || !PHONE || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.error('set API, WIDGET_ORIGIN, CHECK_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD');
  process.exit(2);
}

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const waitFor = (socket, event, pred = () => true, ms = 15_000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, on);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    const on = (p) => {
      if (!pred(p)) return;
      clearTimeout(t);
      socket.off(event, on);
      resolve(p);
    };
    socket.on(event, on);
  });
const stamp = `release-check ${new Date().toISOString()}`;
let customer;
let agent;
let conversationId = null;

try {
  // ── auth ────────────────────────────────────────────────────────────────
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const adminToken = (await login.json())?.data?.access_token;
  step('agent can sign in', !!adminToken, `HTTP ${login.status}`);
  if (!adminToken) throw new Error('no agent token');

  const sess = await fetch(`${API}/chat/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ phone: PHONE }),
  });
  const customerToken = (await sess.json().catch(() => null))?.token;
  step('customer session opens', !!customerToken, `HTTP ${sess.status}`);
  if (!customerToken) throw new Error('no customer token');

  // ── sockets ─────────────────────────────────────────────────────────────
  agent = io(API, { auth: { kind: 'agent', token: adminToken }, transports: ['websocket'] });
  await waitFor(agent, 'connect');
  step('agent socket connects', true);

  customer = io(API, {
    auth: { kind: 'customer', token: customerToken, lazyConversation: true },
    transports: ['websocket'],
    extraHeaders: { origin: ORIGIN },
  });
  const ready = await waitFor(customer, 'ready');
  step('customer socket connects (ready)', true);

  // ── customer → agent ────────────────────────────────────────────────────
  /* A RETURNING customer is attached to their existing conversation at
     `ready` (one conversation per contact); a new one gets it on the first
     message via `conversation:ready`. Both are correct — accept either. */
  const readyP = waitFor(customer, 'conversation:ready', () => true, 15_000).catch(() => null);
  customer.emit('message:send', {
    ...(ready?.conversationId ? { conversationId: ready.conversationId } : {}),
    content: `${stamp} — customer text`,
    clientMsgId: `c1-${Date.now()}`,
  });
  conversationId = String(ready?.conversationId ?? (await readyP)?.conversationId ?? '') || null;
  step('customer message lands in a conversation', !!conversationId, conversationId ?? 'none');
  if (!conversationId) throw new Error('no conversation');

  agent.emit('conversation:subscribe', { conversationId });
  await new Promise((r) => setTimeout(r, 800));
  /* Match THIS message: the first one can still be arriving after subscribe. */
  const agentGets = waitFor(
    agent,
    'message:new',
    (m) => m.senderType === 'customer' && String(m.content).includes('customer second'),
  );
  customer.emit('message:send', {
    conversationId,
    content: `${stamp} — customer second`,
    clientMsgId: `c2-${Date.now()}`,
  });
  const seen = await agentGets;
  step('agent receives the customer message live', seen.content.includes('customer second'));

  // ── agent → customer ────────────────────────────────────────────────────
  const custGets = waitFor(customer, 'message:new', (m) => m.senderType === 'agent');
  agent.emit('message:send', {
    conversationId,
    content: `${stamp} — agent reply`,
    clientMsgId: `a1-${Date.now()}`,
  });
  const reply = await custGets;
  step('customer receives the agent reply live', reply.content.includes('agent reply'));

  // ── edit / delete (EMA-33) ──────────────────────────────────────────────
  const editedP = waitFor(
    customer,
    'message:edited',
    (e) => String(e.messageId) === String(reply.id),
  );
  agent.emit('message:edit', {
    conversationId,
    messageId: reply.id,
    content: `${stamp} — agent reply (edited)`,
  });
  const edited = await editedP;
  step('customer sees the edit live', edited.content.includes('(edited)'));

  const deletedP = waitFor(
    customer,
    'message:deleted',
    (e) => String(e.messageId) === String(reply.id),
  );
  agent.emit('message:delete', { conversationId, messageId: reply.id });
  await deletedP;
  step('customer sees the delete live', true);

  // ── photo upload, as a BROWSER does it (EMA-50) ─────────────────────────
  const pre = await fetch(`${API}/chat/attachment?filename=check.png&type=image%2Fpng`, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  const allowH = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  const allowO = pre.headers.get('access-control-allow-origin');
  step(
    'browser preflight allows the photo upload',
    !!allowO && allowH.includes('authorization') && allowH.includes('content-type'),
    `allow-headers: ${allowH || '(none)'}`,
  );

  // 1×1 PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const up = await fetch(`${API}/chat/attachment?filename=check.png&type=image%2Fpng`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${customerToken}`,
      'content-type': 'image/png',
      origin: ORIGIN,
    },
    body: png,
  });
  const upJson = await up.json().catch(() => null);
  step(
    'customer uploads a photo',
    up.ok && !!upJson?.id,
    `HTTP ${up.status} ${upJson?.error ?? ''}`,
  );

  if (upJson?.id) {
    const agentGetsPhoto = waitFor(agent, 'message:new', (m) => (m.attachments ?? []).length > 0);
    customer.emit('message:send', {
      conversationId,
      content: '',
      attachments: [upJson.id],
      clientMsgId: `c3-${Date.now()}`,
    });
    const photoMsg = await agentGetsPhoto;
    step('agent receives the photo message', photoMsg.attachments.length > 0);
    const fileId =
      typeof photoMsg.attachments[0] === 'string'
        ? photoMsg.attachments[0]
        : photoMsg.attachments[0]?.id;
    const file = await fetch(`${API}/assets/${fileId}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    step('agent can open the photo', file.ok, `HTTP ${file.status}`);
  }

  // ── history after reconnect (the edit/delete markers must survive) ──────
  const histP = waitFor(customer, 'messages:history', () => true, 20_000).catch(() => null);
  customer.disconnect();
  customer.auth = {
    kind: 'customer',
    token: customerToken,
    lazyConversation: true,
    resumeConversationId: conversationId,
  };
  customer.connect();
  const hist = await histP;
  const rows = hist?.messages ?? hist ?? [];
  const deletedRow = Array.isArray(rows)
    ? rows.find((m) => String(m.id) === String(reply.id))
    : null;
  step(
    'history after reconnect keeps the deleted reply hidden',
    !!deletedRow && !deletedRow.content && !!(deletedRow.deletedAt ?? deletedRow.deleted_at),
    deletedRow ? '' : 'reply not found in history',
  );
} catch (err) {
  step('round trip completed', false, err instanceof Error ? err.message : String(err));
} finally {
  // Close the test conversation so it never sits in anyone's queue.
  if (conversationId) {
    try {
      const t = (
        await (
          await fetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: process.env.ADMIN_EMAIL,
              password: process.env.ADMIN_PASSWORD,
            }),
          })
        ).json()
      ).data.access_token;
      await fetch(`${API}/items/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      });
    } catch {
      /* best effort */
    }
  }
  customer?.disconnect();
  agent?.disconnect();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
