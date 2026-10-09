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
 *   customer edits / deletes THEIR OWN message → agent sees it live, and the
 *   customer cannot touch the agent's reply (owner, 2026-10-07)
 *   customer uploads a photo exactly as a browser does: CORS preflight first,
 *   then POST /chat/attachment, then sends it → agent receives it and can open
 *   the file (EMA-50 — photos were refused at the preflight, twice)
 *   a new session's first message is followed by the automatic welcome, which
 *   leaves the first-response clock running (owner, 2026-10-06)
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
let mentionUserId = null;
let mentionEventId = null;

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
  /*
   * THE AUTOMATIC WELCOME (owner, 2026-10-06): the first message of a NEW
   * session — a fresh thread, or a closed one this message reopens (this check
   * closes its thread at the end, so every run after the first is a reopen) —
   * is followed by operations' "رسالة ترحيب" template as an agent-style
   * message marked `automated`. Listened for BEFORE the send so it cannot be
   * missed.
   */
  let priorStatus = null;
  if (ready?.conversationId) {
    const c = await fetch(
      `${API}/items/conversations/${ready.conversationId}?fields=status,initiated_by`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    )
      .then((r) => r.json())
      .catch(() => null);
    priorStatus = c?.data ?? null;
  }
  const newSession =
    !ready?.conversationId ||
    (['solved', 'resolved', 'closed'].includes(priorStatus?.status) &&
      priorStatus?.initiated_by !== 'agent');
  const welcomeP = waitFor(
    customer,
    'message:new',
    (m) => m.senderType === 'agent' && m.automated === true,
    10_000,
  ).catch(() => null);
  customer.emit('message:send', {
    ...(ready?.conversationId ? { conversationId: ready.conversationId } : {}),
    content: `${stamp} — customer text`,
    clientMsgId: `c1-${Date.now()}`,
  });
  conversationId = String(ready?.conversationId ?? (await readyP)?.conversationId ?? '') || null;
  step('customer message lands in a conversation', !!conversationId, conversationId ?? 'none');
  if (!conversationId) throw new Error('no conversation');

  if (newSession) {
    const welcome = await welcomeP;
    step(
      'automatic welcome follows the first message of a new session',
      !!welcome && !welcome.senderUserId,
      welcome ? '' : 'none received (is the رسالة ترحيب row active?)',
    );
    /* THE WELCOME IS NOT AN ANSWER: the first-response clock must still be
       running after it — it is stopped only by a person's reply. */
    const conv = await fetch(
      `${API}/items/conversations/${conversationId}?fields=first_responded_at`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    )
      .then((r) => r.json())
      .catch(() => null);
    step(
      'the automatic welcome does not count as a first response',
      conv?.data?.first_responded_at === null,
      `first_responded_at=${conv?.data?.first_responded_at}`,
    );
  } else {
    console.log('info  conversation was already open — no new session, no welcome expected');
  }

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
  // A PERSON's reply — never the automatic welcome (owner, 2026-10-06).
  const custGets = waitFor(
    customer,
    'message:new',
    (m) => m.senderType === 'agent' && !m.automated && String(m.content).includes('agent reply'),
  );
  agent.emit('message:send', {
    conversationId,
    content: `${stamp} — agent reply`,
    clientMsgId: `a1-${Date.now()}`,
    // Sent as an EDITED quick reply, so the recording is checked end to end
    // (owner, 2026-10-07).
    origin: { source: 'quick_reply', quickReplyId: 'release-check', text: `${stamp} — draft` },
  });
  const reply = await custGets;
  step('customer receives the agent reply live', reply.content.includes('agent reply'));
  const rec = await (
    await fetch(
      `${API}/items/messages/${reply.id}?fields=source,quick_reply_id,source_text,source_edited`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    )
  )
    .json()
    .catch(() => null);
  step(
    'the reply is recorded as an edited quick reply',
    rec?.data?.source === 'quick_reply' &&
      rec.data.quick_reply_id === 'release-check' &&
      rec.data.source_edited === true &&
      String(rec.data.source_text).endsWith('draft'),
  );

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

  // ── the CUSTOMER edits / deletes their own message (owner, 2026-10-07) ──
  const custEditedP = waitFor(
    agent,
    'message:edited',
    (e) => String(e.messageId) === String(seen.id),
  );
  customer.emit('message:edit', {
    conversationId,
    messageId: seen.id,
    content: `${stamp} — customer second (edited by customer)`,
  });
  const custEdited = await custEditedP;
  step(
    "agent sees the customer's edit live",
    String(custEdited.content).includes('(edited by customer)'),
  );

  const agentGetsThird = waitFor(
    agent,
    'message:new',
    (m) => m.senderType === 'customer' && String(m.content).includes('customer third'),
  );
  customer.emit('message:send', {
    conversationId,
    content: `${stamp} — customer third (to delete)`,
    clientMsgId: `c4-${Date.now()}`,
  });
  const third = await agentGetsThird;
  const custDeletedP = waitFor(
    agent,
    'message:deleted',
    (e) => String(e.messageId) === String(third.id),
  );
  customer.emit('message:delete', { conversationId, messageId: third.id });
  await custDeletedP;
  step("agent sees the customer's delete live", true);

  /* Never someone else's words: the customer trying to change the AGENT's
     reply is refused by the gateway, whatever the widget shows. */
  const refusedP = waitFor(customer, 'error', (e) => e?.code === 'not_own_message', 10_000).catch(
    () => null,
  );
  customer.emit('message:edit', { conversationId, messageId: reply.id, content: 'tamper' });
  const refused = await refusedP;
  step("customer cannot edit the agent's reply", !!refused, refused ? '' : 'no refusal received');

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

  // ── @mention in an internal note reaches the colleague (owner 2026-10-09) ──
  /* The gateway used to drop note mentions. A throwaway colleague (example.com,
     never a real inbox) is mentioned and must get an in-app `mention` row.
     STAGING ONLY: it creates and deletes a user. */
  if (/staging|localhost/.test(API)) {
    const h = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    const roleId = (
      await (
        await fetch(`${API}/roles?filter[name][_eq]=WeCare%20Agent&fields=id`, { headers: h })
      ).json()
    )?.data?.[0]?.id;
    const made = await (
      await fetch(`${API}/users`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          email: `mention-check-${Date.now()}@staff.example.com`,
          password: `${Math.random().toString(36).slice(2)}Aa1!x9`,
          role: roleId,
          first_name: 'Mention',
          last_name: 'Check',
          status: 'active',
        }),
      })
    ).json();
    mentionUserId = made?.data?.id ?? null;
    if (mentionUserId) {
      agent.emit('note:add', {
        conversationId,
        content: `${stamp} — note for @mention-check`,
        mentions: [mentionUserId],
        clientMsgId: `n1-${Date.now()}`,
      });
      let row = null;
      for (let i = 0; i < 20 && !row; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        row = (
          await (
            await fetch(
              `${API}/items/notifications?filter[recipient][_eq]=${mentionUserId}&filter[type][_eq]=mention&fields=id,link&limit=1`,
              { headers: h },
            )
          ).json()
        )?.data?.[0];
      }
      step(
        'a colleague @mentioned in a chat note is notified',
        !!row && String(row.link).includes(conversationId),
        row ? '' : 'no mention notification within 30s',
      );
      // Same colleague, named in a TICKET comment (notify-on-change hook).
      const ticketId = (
        await (
          await fetch(`${API}/items/tickets?fields=id&limit=1&sort=-date_created`, { headers: h })
        ).json()
      )?.data?.[0]?.id;
      if (ticketId) {
        const ev = await (
          await fetch(`${API}/items/ticket_events`, {
            method: 'POST',
            headers: h,
            body: JSON.stringify({
              ticket: ticketId,
              event_type: 'commented',
              payload: { text: `${stamp} — @mention-check`, mentions: [mentionUserId] },
            }),
          })
        ).json();
        mentionEventId = ev?.data?.id ?? null;
        let trow = null;
        for (let i = 0; i < 10 && !trow; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          trow = (
            await (
              await fetch(
                `${API}/items/notifications?filter[recipient][_eq]=${mentionUserId}&filter[type][_eq]=mention&filter[link][_eq]=/tickets/${ticketId}&fields=id&limit=1`,
                { headers: h },
              )
            ).json()
          )?.data?.[0];
        }
        step(
          'a colleague @mentioned in a ticket comment is notified',
          !!trow,
          trow ? '' : 'no mention notification within 10s',
        );
      }
    } else
      step(
        'a colleague @mentioned in a chat note is notified',
        false,
        'could not create test colleague',
      );
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
  const find = (id) => (Array.isArray(rows) ? rows.find((m) => String(m.id) === String(id)) : null);
  const custEditedRow = find(seen.id);
  step(
    "history after reconnect keeps the customer's edit (with its marker)",
    !!custEditedRow &&
      String(custEditedRow.content).includes('(edited by customer)') &&
      !!(custEditedRow.editedAt ?? custEditedRow.edited_at),
    custEditedRow ? '' : 'edited message not found in history',
  );
  const custDeletedRow = find(third.id);
  step(
    "history after reconnect keeps the customer's deleted message hidden",
    !!custDeletedRow &&
      !custDeletedRow.content &&
      !!(custDeletedRow.deletedAt ?? custDeletedRow.deleted_at),
    custDeletedRow ? '' : 'deleted message not found in history',
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
  if (mentionUserId) {
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
      const h = { authorization: `Bearer ${t}` };
      const ids = (
        await (
          await fetch(
            `${API}/items/notifications?filter[recipient][_eq]=${mentionUserId}&fields=id&limit=-1`,
            { headers: h },
          )
        ).json()
      )?.data?.map((n) => n.id);
      if (ids?.length)
        await fetch(`${API}/items/notifications`, {
          method: 'DELETE',
          headers: { ...h, 'content-type': 'application/json' },
          body: JSON.stringify(ids),
        });
      if (mentionEventId)
        await fetch(`${API}/items/ticket_events/${mentionEventId}`, {
          method: 'DELETE',
          headers: h,
        });
      await fetch(`${API}/users/${mentionUserId}`, { method: 'DELETE', headers: h });
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
