/**
 * Does a chat actually move when its agent signs out and stays out?
 *
 * The rule (owner, 2026-09-10): reassign ONLY if the agent logged out and did
 * not come back within 90 s. Never because they went quiet.
 *
 * Run against DEPLOYED staging, so it exercises the real gateway, the real
 * BullMQ delay and the real worker.
 */
import { io } from 'socket.io-client';

const API = 'https://d2vi34f7wgjecb.cloudfront.net';
const AGENT = { email: 'e2e.agent@example.com', password: '123456' };
const PHONE = process.env.PROBE_PHONE || '0500000944';

const j = (r) => r.json();
const login = async (c) =>
  fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c),
  }).then(j);

const auth = await login(AGENT);
const token = auth?.data?.access_token;
if (!token) { console.error('agent login failed', JSON.stringify(auth).slice(0, 200)); process.exit(1); }
const me = await fetch(`${API}/users/me?fields=id,email`, {
  headers: { authorization: `Bearer ${token}` },
}).then(j);
const agentId = me?.data?.id;
console.log('agent:', me?.data?.email, agentId);

// 1. Customer opens a chat and sends a message (this starts the assign ladder).
const session = await fetch(`${API}/walk-in/session`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: PHONE }),
}).then(j);

const cust = io(API, { transports: ['polling'], auth: { token: session.token, lazyConversation: true } });
const convId = await new Promise((res, rej) => {
  cust.on('message:new', (m) => res(m.conversationId));
  cust.on('connect', () =>
    cust.emit('message:send', { content: 'PROBE reclaim ' + Date.now(), clientMsgId: 'p' + Date.now() }));
  cust.on('connect_error', (e) => rej(new Error(e.message)));
  setTimeout(() => rej(new Error('no conversation')), 30000);
});
console.log('conversation:', convId);

const readConv = async () =>
  fetch(`${API}/items/conversations/${convId}?fields=id,status,assigned_agent`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(j).then((r) => r?.data);

// 2. Agent connects and takes the chat.
const ag = io(API, { transports: ['polling'], auth: { kind: 'agent', token } });
await new Promise((r) => ag.on('connect', r));
console.log('agent socket connected');
await fetch(`${API}/items/conversations/${convId}`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ assigned_agent: agentId }),
});
console.log('assigned to agent:', (await readConv())?.assigned_agent === agentId);

// 3. Agent SIGNS OUT and stays out.
ag.emit('agent:logout');
setTimeout(() => ag.disconnect(), 300);
console.log('agent logged out; waiting 105s for the reclaim...');
await new Promise((r) => setTimeout(r, 105000));

const after = await readConv();
console.log('owner after reclaim window:', after?.assigned_agent);
console.log(
  after?.assigned_agent !== agentId
    ? 'PASS: the chat moved off the signed-out agent'
    : 'FAIL: still owned by the signed-out agent',
);
cust.disconnect();
process.exit(0);
