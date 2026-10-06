import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_PRIVILEGES,
  OWNER_PRIVILEGES,
  OWNER_PRIVILEGE_DEFAULTS,
  PRIVILEGES,
  effectivePrivileges,
  roleNamesHolding,
} from '../src/privileges.js';

/**
 * The Administrator's fine-grained permissions (owner, 2026-10-06) live in TWO
 * places: here, read by both portals and the services, and in the
 * app-roles-sync extension, which decides what a role is GRANTED in the
 * database. A bare Directus hook cannot import this package, so it carries a
 * copy — and a copy that drifts means the screen offers one thing and the
 * database grants another. These tests fail the moment they disagree.
 */
const SYNC_PATH = fileURLToPath(
  new URL('../../../directus/extensions/app-roles-sync/index.js', import.meta.url),
);
const SYNC = readFileSync(SYNC_PATH, 'utf8');

function extensionDefaults(): Record<string, (p: Record<string, boolean>, r: string) => boolean> {
  const start = SYNC.indexOf('const nameIn =');
  const end = SYNC.indexOf('const OWNER_PRIVILEGES = Object.keys');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${SYNC.slice(start, end)}; return OWNER_PRIVILEGE_DEFAULTS;`)();
}

/** The live production roles on 2026-10-06, plus the code-defined ones. */
const ROLES: Array<[string, string[]]> = [
  ['Administrator', []],
  ['Admin', []],
  ['Agent', []],
  [
    'WeCare Admin',
    [
      'use_chat',
      'view_tickets',
      'create_tickets',
      'edit_tickets',
      'export_data',
      'view_all_chats',
      'view_all_tickets',
      'edit_all_tickets',
      'delete_tickets',
      'import_data',
      'approve_coupons',
      'view_dashboard',
      'manage_users',
      'manage_restaurants',
      'manage_sla',
      'schedule_reports',
      'manage_roles',
      'manage_lists',
      'manage_backup',
      'view_ops_dashboard',
    ],
  ],
  [
    'WeCare Supervisor',
    [
      'use_chat',
      'view_tickets',
      'create_tickets',
      'edit_tickets',
      'export_data',
      'view_all_chats',
      'view_all_tickets',
      'edit_all_tickets',
      'delete_tickets',
      'approve_coupons',
      'view_dashboard',
      'manage_users',
      'manage_lists',
      'view_ops_dashboard',
    ],
  ],
  [
    'WeCare Agent',
    [
      'use_chat',
      'view_tickets',
      'create_tickets',
      'edit_tickets',
      'export_data',
      'view_all_tickets',
      'edit_all_tickets',
    ],
  ],
  ['Okashi Area Manager', ['view_tickets', 'view_all_tickets', 'view_dashboard', 'export_data']],
  ['Operations', ['view_dashboard', 'view_ops_dashboard', 'view_all_tickets', 'export_data']],
  [
    'Viewer',
    ['view_all_chats', 'view_tickets', 'view_all_tickets', 'view_dashboard', 'export_data'],
  ],
];
const mapOf = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));

describe('fine-grained permissions: the extension agrees with shared-types', () => {
  it('names the same keys', () => {
    expect(Object.keys(extensionDefaults()).sort()).toEqual([...OWNER_PRIVILEGES].sort());
  });

  it('defaults every key the same way for every live role', () => {
    const ext = extensionDefaults();
    for (const [name, keys] of ROLES) {
      for (const key of OWNER_PRIVILEGES) {
        const role = name.toLowerCase();
        expect([name, key, ext[key]!(mapOf(keys), role)]).toEqual([
          name,
          key,
          OWNER_PRIVILEGE_DEFAULTS[key](mapOf(keys), role),
        ]);
      }
    }
  });

  it('has a CATALOG entry for every key, or a save would be refused', () => {
    for (const key of ALL_PRIVILEGES) {
      expect(SYNC, key).toMatch(new RegExp(`\\n    ${key}: \\[`));
    }
  });
});

describe('effectivePrivileges', () => {
  it('keeps the shared keys exactly as stored', () => {
    const eff = effectivePrivileges({ use_chat: true, view_all_chats: false }, 'X');
    expect(eff.use_chat).toBe(true);
    expect(eff.view_all_chats).toBe(false);
  });

  it('a stored owner key beats its default, either way', () => {
    expect(effectivePrivileges({ use_chat: true, close_chats: false }, 'X').close_chats).toBe(
      false,
    );
    expect(effectivePrivileges({ delete_chats: true }, 'X').delete_chats).toBe(true);
  });

  it('changes nothing for today’s roles: the old role-name rules, reproduced', () => {
    expect(effectivePrivileges({}, 'WeCare Agent').receive_chats).toBe(true);
    expect(effectivePrivileges({}, 'WeCare Admin').receive_chats).toBe(false);
    expect(effectivePrivileges({}, 'Administrator').no_agents_alert).toBe(true);
    expect(effectivePrivileges({}, 'WeCare Agent').view_ticket_history).toBe(false);
    expect(effectivePrivileges({}, 'WeCare Supervisor').view_ticket_history).toBe(true);
    expect(effectivePrivileges({}, 'WeCare Supervisor').delete_users).toBe(false);
    expect(effectivePrivileges({}, 'WeCare Admin').delete_users).toBe(true);
    expect(effectivePrivileges({}, 'Okashi Area Manager').view_order_details).toBe(false);
    expect(effectivePrivileges({}, 'WeCare Agent').view_order_details).toBe(true);
  });

  it('never adds a shared key', () => {
    const eff = effectivePrivileges({}, 'Administrator');
    for (const key of PRIVILEGES) expect(eff[key]).toBeUndefined();
  });
});

describe('roleNamesHolding', () => {
  it('routes to exactly the roles the workers used to name', () => {
    const names = ['WeCare Agent', 'WeCare Supervisor', 'WeCare Admin', 'Administrator', 'Viewer'];
    const rows = ROLES.map(([name, keys]) => ({ name, privileges: mapOf(keys) }));
    expect(roleNamesHolding('receive_chats', names, rows)).toEqual([
      'WeCare Agent',
      'WeCare Supervisor',
    ]);
    expect(roleNamesHolding('no_agents_alert', names, rows)).toEqual([
      'WeCare Supervisor',
      'WeCare Admin',
      'Administrator',
    ]);
  });

  it('follows a switch the owner flipped, stored as JSON text or as an object', () => {
    const rows = [
      { name: 'WeCare Admin', privileges: JSON.stringify({ receive_chats: true }) },
      { name: 'WeCare Agent', privileges: { receive_chats: false } },
    ];
    expect(roleNamesHolding('receive_chats', ['WeCare Agent', 'WeCare Admin'], rows)).toEqual([
      'WeCare Admin',
    ]);
  });
});
