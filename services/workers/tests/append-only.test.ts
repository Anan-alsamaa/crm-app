import { describe, it, expect } from 'vitest';
import { roles } from '../../../directus/bootstrap/src/roles.js';

/**
 * T069 — ticket_events is append-only across the entire role / policy matrix.
 *
 * Verified against the declarative source of truth (`directus/bootstrap/src/
 * roles.ts`) which is what the bootstrap applies. We assert: NO custom role
 * (including service accounts) grants `update` or `delete` on ticket_events.
 * The Administrator role is intentionally out of scope here — built-in
 * Directus admins always bypass policy permissions; the spec calls for
 * append-only at the role-permission layer, which is what we check.
 */
describe('ticket_events append-only (T069)', () => {
  it('no custom role/policy grants update or delete on ticket_events', () => {
    const violations: string[] = [];
    for (const role of roles) {
      if (!role.permissions) continue;
      for (const p of role.permissions) {
        if (p.collection !== 'ticket_events') continue;
        if (p.action === 'update' || p.action === 'delete') {
          violations.push(`${role.name}: ${p.action}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every role with ticket_events access has at most {create, read}', () => {
    const allowed = new Set(['create', 'read']);
    for (const role of roles) {
      if (!role.permissions) continue;
      for (const p of role.permissions) {
        if (p.collection !== 'ticket_events') continue;
        expect(allowed.has(p.action)).toBe(true);
      }
    }
  });
});
