import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPORT_ACCESS_PRIVILEGES, effectivePrivileges, opensPortal } from '../src/privileges.js';

/**
 * ONE LINE PER DASHBOARD AND PER REPORT (owner, 2026-10-12): View agent
 * dashboard, View operations dashboard, View agent summary reports, View
 * ticket deadline report, View late orders report - instead of one "View
 * dashboards & reports". Shipping it must change NOTHING anybody sees until
 * the owner ticks a box.
 */
const on = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, true]));

/** Production app_roles on 2026-10-12, reporting keys only. */
const PROD: Array<[string, Record<string, boolean>]> = [
  [
    'Department Manager',
    on('view_dashboard', 'view_ops_dashboard', 'view_all_chats', 'view_all_tickets'),
  ],
  ['TV Screen', on('view_dashboard')],
  [
    'WeCare Admin',
    on('view_dashboard', 'view_ops_dashboard', 'view_all_chats', 'view_all_tickets'),
  ],
  ['Casapasta Area Manager', on('view_dashboard', 'view_all_tickets')],
  ['WeCare Agent', on('view_all_chats', 'view_all_tickets')],
  [
    'WeCare Supervisor',
    on('view_dashboard', 'view_ops_dashboard', 'view_all_chats', 'view_all_tickets'),
  ],
  ['Operations', on('view_dashboard', 'view_ops_dashboard', 'view_all_tickets')],
  ['Viewer', on('view_dashboard', 'view_all_chats', 'view_all_tickets')],
];

/** What the Dashboard page showed before: the page needed view_dashboard;
    the Agent tab view_all_chats; Operations its switch OR the fallback for
    a role with no Agent tab. */
function before(p: Record<string, boolean>) {
  const page = p.view_dashboard === true;
  const agent = page && p.view_all_chats === true;
  const ops = page && (p.view_ops_dashboard === true || !agent);
  return { agent, ops };
}

describe('the dashboard split changes nobody', () => {
  it.each(PROD)('%s sees exactly the boards it saw', (name, stored) => {
    const eff = effectivePrivileges(stored, name);
    expect({ agent: eff.view_agent_dashboard, ops: eff.view_ops_dashboard }).toEqual(
      before(stored),
    );
  });

  it('a switch set by the owner wins over the old fallback', () => {
    const eff = effectivePrivileges({ view_dashboard: true, view_ops_dashboard: false }, 'TV');
    expect(eff.view_ops_dashboard).toBe(false);
  });
});

describe('each dashboard and report opens the admin portal on its own', () => {
  it.each(REPORT_ACCESS_PRIVILEGES)('%s alone lets a role sign in', (key) => {
    // Every other line explicitly off, so no default can open the door instead.
    const stored = Object.fromEntries(REPORT_ACCESS_PRIVILEGES.map((k) => [k, k === key]));
    expect(opensPortal(effectivePrivileges(stored, 'TV Screen'), 'admin')).toBe(true);
  });

  it('none of them: the door stays shut', () => {
    const stored = Object.fromEntries(REPORT_ACCESS_PRIVILEGES.map((k) => [k, false]));
    expect(opensPortal(effectivePrivileges(stored, 'TV Screen'), 'admin')).toBe(false);
  });
});

describe('the database grants follow the same lines', () => {
  const SYNC = readFileSync(
    fileURLToPath(new URL('../../../directus/extensions/app-roles-sync/index.js', import.meta.url)),
    'utf8',
  );
  it('the extension lists the same report lines', () => {
    const m = /const REPORT_ACCESS = \[([^\]]*)\]/.exec(SYNC);
    const keys = (m?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((k) => k.slice(1, -1));
    expect(keys).toEqual([...REPORT_ACCESS_PRIVILEGES]);
  });
  it('any of them brings the reads view_dashboard used to carry alone', () => {
    expect(SYNC).toMatch(
      /if \(REPORT_ACCESS\.some\(\(k\) => privileges\?\.\[k\] === true\)\) CATALOG\.view_dashboard\.forEach\(add\);/,
    );
  });
  it('the extension keeps the same Operations fallback', () => {
    expect(SYNC).toMatch(
      /p\.view_ops_dashboard = p\.view_dashboard === true && p\.view_all_chats !== true;/,
    );
  });
});
