import { describe, it, expect } from 'vitest';
import { roles } from '../../../directus/bootstrap/src/roles.js';
import { yijiInboundToken } from '../src/yiji-inbound-directus.js';

/**
 * THE "YIJI" USER (owner, 2026-11-03).
 *
 * Everything Yiji does through the inbound API is recorded under a user called
 * "Yiji" - not under the gateway's account, which also runs every chat. The
 * gateway writes as Yiji when SVC_YIJI_TOKEN is set; otherwise exactly as
 * before.
 */

describe('which token the Yiji inbound API writes with', () => {
  it("is the Yiji user's", () => {
    expect(yijiInboundToken({ SVC_YIJI_TOKEN: 'yiji-tok' })).toBe('yiji-tok');
    expect(yijiInboundToken({ SVC_YIJI_TOKEN: '  yiji-tok ' })).toBe('yiji-tok');
  });
  it('is nothing when it is not set - never the gateway account (the API then answers 503)', () => {
    expect(yijiInboundToken({ SVC_YIJI_TOKEN: '' })).toBeNull();
    expect(yijiInboundToken({ SVC_YIJI_TOKEN: '   ' })).toBeNull();
    expect(yijiInboundToken({})).toBeNull();
  });
});

describe('the svc-yiji role', () => {
  const yiji = roles.find((r) => r.name === 'svc-yiji')!;
  const gateway = roles.find((r) => r.name === 'svc-socket-gateway')!;
  const grants = (r: typeof yiji) =>
    (r.permissions ?? []).map((p) => `${p.collection}:${p.action}`);

  it('is a service account shown as "Yiji", with its own token', () => {
    expect(yiji).toBeDefined();
    expect(yiji.displayName).toBe('Yiji');
    expect(yiji.serviceTokenEnv).toBe('SVC_YIJI_TOKEN');
    expect(yiji.appAccess).toBe(false);
    expect(yiji.adminAccess).toBe(false);
  });

  /* Every collection the inbound store reads or writes (yiji-inbound-directus.ts). */
  it('holds every right the inbound API uses', () => {
    const need = [
      'vendors:read',
      'tickets:read',
      'tickets:create',
      'tickets:update',
      'coupon_approvals:read',
      'coupon_approvals:create',
      'ticket_events:create',
      'contacts:read',
      'contacts:create',
      'contacts:update',
      'stores:read',
      'brands:read',
      'store_notifications:create',
      'compensation_rules:read',
      'app_settings:read',
    ];
    for (const g of need) expect(grants(yiji)).toContain(g);
  });

  it('holds nothing beyond the inbound API: no chats, no deletes, no settings writes', () => {
    const allowed = new Set([
      'vendors:read',
      'tickets:read',
      'tickets:create',
      'tickets:update',
      'coupon_approvals:read',
      'coupon_approvals:create',
      'ticket_events:create',
      'ticket_events:read',
      'contacts:read',
      'contacts:create',
      'contacts:update',
      'stores:read',
      'brands:read',
      'store_notifications:create',
      'compensation_rules:read',
      'app_settings:read',
      'directus_users:read',
    ]);
    for (const g of grants(yiji)) expect(allowed).toContain(g);
  });

  it('the chat gateway itself can no longer write anything for Yiji', () => {
    const g = grants(gateway);
    for (const w of [
      'tickets:create',
      'tickets:update',
      'coupon_approvals:create',
      'ticket_events:create',
      'store_notifications:create',
    ])
      expect(g).not.toContain(w);
    // what its own features use stays
    for (const keep of [
      'tickets:read',
      'coupon_approvals:read',
      'contacts:create',
      'messages:create',
    ])
      expect(g).toContain(keep);
  });

  it('can update a ticket only to mark it compensated, and only Yiji-raised tickets', () => {
    const u = yiji.permissions!.find((p) => p.collection === 'tickets' && p.action === 'update')!;
    expect(u.fields).toEqual(['compensation']);
    expect(u.permissions).toEqual({ external_id: { _nnull: true } });
  });

  it('reads only its own user record', () => {
    const u = yiji.permissions!.find((p) => p.collection === 'directus_users')!;
    expect(u.action).toBe('read');
    expect(u.permissions).toEqual({ id: { _eq: '$CURRENT_USER' } });
  });
});
