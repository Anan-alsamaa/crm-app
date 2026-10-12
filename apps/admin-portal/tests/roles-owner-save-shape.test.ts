import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/directus.js', () => ({ directus: { request: vi.fn() } }));

import { ownerSaveShape } from '../src/features/app-roles/RolesPage.js';

/* Owner, 2026-10-12: "View dashboards & reports" is no longer a line for the
   owner; it follows the dashboard and report lines on save. */
describe('ownerSaveShape', () => {
  it('turns view_dashboard on when any dashboard or report line is on', () => {
    const out = ownerSaveShape({ view_late_orders_report: true }, 'TV Screen');
    expect(out.view_dashboard).toBe(true);
  });

  it('turns it off when every line is off', () => {
    const out = ownerSaveShape(
      {
        view_dashboard: true,
        view_agent_dashboard: false,
        view_ops_dashboard: false,
        view_agent_reports: false,
        view_sla_report: false,
        view_late_orders_report: false,
      },
      'TV Screen',
    );
    expect(out.view_dashboard).toBe(false);
  });

  it('writes the boards out as the editor showed them (the fallback included)', () => {
    const out = ownerSaveShape({ view_dashboard: true, view_all_tickets: true }, 'Area Manager');
    expect(out.view_ops_dashboard).toBe(true);
    expect(out.view_agent_dashboard).toBe(false);
    expect(out.view_dashboard).toBe(true);
  });
});
