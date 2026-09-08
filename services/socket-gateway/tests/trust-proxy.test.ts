import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';

/**
 * `req.ip` must be the CUSTOMER, through the load balancer.
 *
 * This exists because an upgrade nearly broke it in silence. `trustProxy` was
 * a HOP COUNT until Fastify 5.12.1, which fixed an X-Forwarded-* advisory by
 * making a numeric value fail CLOSED — trusting nobody and ignoring the header
 * entirely. Nothing failed: the service still started, still answered, and
 * every customer simply collapsed onto the ALB's address, which throttles the
 * whole customer base after the fifth QR scan of the day (the walk-in limit is
 * 5, then one every 30s). A type error was the only signal, and silencing it
 * would have shipped the outage.
 *
 * So this asserts the BEHAVIOUR — a resolved customer address — rather than
 * the option's shape, which is what changed underneath it.
 */
const REQUIRED = { YIJI_JWT_SECRET: 'secret', SVC_GATEWAY_TOKEN: 'tok' };

/** Build the app the way the gateway does, and ask it what it thinks the ip is. */
async function ipSeenBy(trustProxy: string[] | false, headers: Record<string, string>) {
  const app: FastifyInstance = Fastify({ trustProxy });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
    return (await res.json()).ip as string;
  } finally {
    await app.close();
  }
}

/** The config's own default, parsed the way index.ts parses it. */
function configuredCidrs() {
  const cfg = loadConfig();
  return cfg.TRUST_PROXY_CIDRS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('trustProxy', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.TRUST_PROXY_CIDRS;
    Object.assign(process.env, REQUIRED);
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('trusts the VPC range by default, so the ALB is a trusted peer', () => {
    // 127.0.0.1 stands in for the ALB below: both are peers on the list.
    expect(configuredCidrs()).toContain('192.168.0.0/16');
    expect(configuredCidrs()).toContain('127.0.0.1');
  });

  it('resolves the CUSTOMER address from X-Forwarded-For', async () => {
    const ip = await ipSeenBy(configuredCidrs(), {
      'x-forwarded-for': '203.0.113.9, 192.168.1.5',
    });
    expect(ip).toBe('203.0.113.9');
  });

  it('falls back to the peer when no forwarding header is present', async () => {
    expect(await ipSeenBy(configuredCidrs(), {})).toBe('127.0.0.1');
  });

  it('ignores forwarding headers entirely when nothing is trusted', async () => {
    // The empty-string setting, for a process reached directly.
    const ip = await ipSeenBy(false, { 'x-forwarded-for': '203.0.113.9' });
    expect(ip).toBe('127.0.0.1');
  });
});
