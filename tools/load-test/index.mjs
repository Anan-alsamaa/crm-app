/**
 * Concurrency load test for the Yiji CRM socket-gateway.
 *
 * Spins up N customer Socket.IO clients (each a signed widget JWT) that connect
 * near-simultaneously and each send K messages, plus M agent clients that count
 * the broadcast events they receive. Proves the gateway handles concurrent
 * customers end-to-end (connect → persist → echo) and shows exactly what reaches
 * the agents (inbox:activity to ALL agents; message:new only to the conversation
 * room — i.e. agents viewing/assigned to that thread).
 *
 * Run:
 *   cd crm-app-infra/tools/load-test && npm install
 *   YIJI_JWT_SECRET=<secret> CUSTOMERS=100 node index.mjs
 *
 * Env: GATEWAY_URL (http://localhost:8080), DIRECTUS_URL (http://localhost:8055),
 *      YIJI_JWT_SECRET (required), CUSTOMERS (100), AGENTS (3), MSGS (3),
 *      AGENT_EMAIL / AGENT_PASSWORD, VENDOR_ID (demo-vendor).
 */
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const DIRECTUS = process.env.DIRECTUS_URL ?? 'http://localhost:8055';
const SECRET = process.env.YIJI_JWT_SECRET ?? '';
const CUSTOMERS = Number(process.env.CUSTOMERS ?? 100);
const AGENTS = Number(process.env.AGENTS ?? 3);
const MSGS = Number(process.env.MSGS ?? 3);
const AGENT_EMAIL = process.env.AGENT_EMAIL ?? 'e2e.agent@example.com';
const AGENT_PASSWORD = process.env.AGENT_PASSWORD ?? 'E2eAgentPass1!';
const VENDOR = process.env.VENDOR_ID ?? 'demo-vendor';

if (!SECRET) {
  console.error('YIJI_JWT_SECRET is required (the gateway HS256 secret).');
  process.exit(1);
}

const stamp = Date.now();
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const metrics = { connected: 0, connFail: 0, sent: 0, echoed: 0, latencies: [], errors: {} };
const agentRx = { inboxActivity: 0, messageNew: 0 };
const recordErr = (e) => {
  const k = String(e).slice(0, 60);
  metrics.errors[k] = (metrics.errors[k] || 0) + 1;
};

const customerToken = (i) =>
  jwt.sign(
    {
      vendor_id: VENDOR,
      customer_id: `lt-${stamp}-${i}`,
      phone: `+96650${String(1000000 + i).slice(-7)}`,
      email: `lt${i}@loadtest.local`,
      name: `LoadTest ${i}`,
    },
    SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  );

async function getAgentToken() {
  const r = await fetch(`${DIRECTUS}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: AGENT_EMAIL, password: AGENT_PASSWORD }),
  });
  if (!r.ok) throw new Error(`agent login failed: ${r.status}`);
  return (await r.json()).data.access_token;
}

async function main() {
  console.log(
    `Load test → ${GATEWAY}\n  customers=${CUSTOMERS} agents=${AGENTS} msgs/customer=${MSGS}\n`,
  );
  const agentToken = await getAgentToken();

  const agents = [];
  for (let a = 0; a < AGENTS; a++) {
    const s = io(GATEWAY, {
      auth: { kind: 'agent', token: agentToken },
      transports: ['websocket'],
      reconnection: false,
    });
    s.on('inbox:activity', () => agentRx.inboxActivity++);
    s.on('message:new', () => agentRx.messageNew++);
    s.on('connect_error', (e) => recordErr(`agent: ${e.message}`));
    agents.push(s);
  }
  await new Promise((r) => setTimeout(r, 1500)); // let agents join agents:all

  const t0 = Date.now();
  const customers = [];
  await Promise.all(
    Array.from(
      { length: CUSTOMERS },
      (_, i) =>
        new Promise((resolve) => {
          const s = io(GATEWAY, {
            auth: { token: customerToken(i) },
            transports: ['websocket'],
            reconnection: false,
          });
          const pending = new Map();
          customers.push(s);
          s.on('connect_error', (e) => {
            metrics.connFail++;
            recordErr(e.message);
            resolve();
          });
          s.on('ready', (p) => {
            metrics.connected++;
            for (let m = 0; m < MSGS; m++) {
              const cid = `${i}-${m}`;
              pending.set(cid, Date.now());
              metrics.sent++;
              s.emit('message:send', {
                conversationId: p.conversationId,
                content: `load ${i}-${m}`,
                clientMsgId: cid,
              });
            }
            resolve();
          });
          s.on('message:new', (msg) => {
            if (msg?.clientMsgId && pending.has(msg.clientMsgId)) {
              metrics.echoed++;
              metrics.latencies.push(Date.now() - pending.get(msg.clientMsgId));
              pending.delete(msg.clientMsgId);
            }
          });
          s.on('error', (e) => recordErr(e?.code || e?.message || 'err'));
        }),
    ),
  );
  const connectMs = Date.now() - t0;

  await new Promise((r) => setTimeout(r, 6000)); // let echoes + broadcasts settle

  console.log('=== RESULTS ===');
  console.log(`connected:        ${metrics.connected}/${CUSTOMERS}  (failed ${metrics.connFail})`);
  console.log(`connect burst:    ${connectMs}ms to connect+seed ${CUSTOMERS} customers`);
  console.log(`messages sent:    ${metrics.sent}`);
  console.log(`echoes received:  ${metrics.echoed}/${metrics.sent}  (round-trip persist+broadcast)`);
  console.log(
    `round-trip (ms):  p50=${pct(metrics.latencies, 0.5)}  p95=${pct(metrics.latencies, 0.95)}  max=${metrics.latencies.length ? Math.max(...metrics.latencies) : 0}`,
  );
  console.log(
    `agent broadcasts: inbox:activity=${agentRx.inboxActivity}  message:new=${agentRx.messageNew}  (across ${AGENTS} agents)`,
  );
  console.log(`errors:           ${JSON.stringify(metrics.errors)}`);
  customers.forEach((s) => s.close());
  agents.forEach((s) => s.close());
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => {
  console.error('load test failed:', e);
  process.exit(1);
});
