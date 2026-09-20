import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * THE SESSION ENDPOINT SERVES BOTH DOORS, SO IT NEEDS A NAME THAT SAYS SO.
 *
 * `/walk-in/session` opens a chat for a QR visitor AND for a customer arriving
 * from the app. Only the first is a walk-in, so the name describes half of what
 * it does — and the next integrator reads that name before they read anything
 * else.
 *
 * `/walk-in/chat-session` is the name to use. The old path STAYS: the app calls
 * it today, and an endpoint a third party depends on is not ours to retire on
 * our own schedule.
 *
 * Both must remain under `/walk-in/*`, which is an explicit load-balancer rule.
 * A prettier `/session` would be routed to Directus and answered with
 * ROUTE_NOT_FOUND — the endpoint would exist, run, and never be reached. That
 * has already happened once here, with the release endpoints.
 */
/* Vitest runs this from the repo root AND from the package, so resolve both. */
const CANDIDATES = ['src/index.ts', 'services/socket-gateway/src/index.ts'];
const SOURCE = readFileSync(
  CANDIDATES.map((c) => resolve(process.cwd(), c)).find((f) => existsSync(f))!,
  'utf8',
);

describe('the chat session endpoint', () => {
  it('still serves the original path the app calls', () => {
    expect(SOURCE).toContain("'/walk-in/session'");
  });

  it('also serves the generic name', () => {
    expect(SOURCE).toContain("'/walk-in/chat-session'");
  });

  it('keeps both under the prefix the load balancer routes here', () => {
    const paths = [...SOURCE.matchAll(/'(\/walk-in\/[a-z-]+)'/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith('/walk-in/')).toBe(true);
  });
});
