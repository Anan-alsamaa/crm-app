import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * A CALLER THAT SAYS NOTHING IS NOT STANDING AT A COUNTER.
 *
 * `entryPoint` defaulted to `store_qr` back when the branch QR page was the
 * only caller. It is not any more: an integrator's backend opens a chat for
 * somebody in their own app, and the owner asked for a payload with nothing
 * situational in it (2026-09-21). Defaulting such a caller to `store_qr` files
 * every app customer as a branch visitor.
 *
 * The field STAYS in the contract. Nothing can infer the door — a branch
 * visitor may well hold an account, so `customerId` does not answer it — and
 * it is what keeps `walk_in_app` (an account holder in a shop) distinguishable
 * from an ordinary app session.
 *
 * BOTH HALVES SHIP TOGETHER. Flip the default alone and the QR page, which
 * sent no such field, silently starts reporting `app`.
 */
const read = (rels: string[]) =>
  readFileSync(rels.map((r) => resolve(process.cwd(), r)).find((f) => existsSync(f))!, 'utf8');

const GATEWAY = read(['src/index.ts', 'services/socket-gateway/src/index.ts']);
const WALK_IN = read(['../../apps/chat-widget/src/walk-in.ts', 'apps/chat-widget/src/walk-in.ts']);

describe('entryPoint', () => {
  it('defaults to app when a caller omits it', () => {
    expect(GATEWAY).toContain("parsed.data.entryPoint ?? 'app'");
  });

  it('is still accepted from callers that do send it', () => {
    expect(GATEWAY).toContain('parsed.data.entryPoint');
  });

  /* The other half. Without this the branch QR page inherits the new default
     and every walk-in is reported as an app session. */
  it('is stated explicitly by our own branch QR page', () => {
    expect(WALK_IN).toContain("entryPoint: 'store_qr'");
  });
});
