import { describe, expect, it } from 'vitest';
import {
  OWNER_PRIVILEGES,
  PRIVILEGES,
  PRIVILEGE_PORTAL,
  effectivePrivileges,
} from '../src/privileges.js';

/*
 * The switches added for the CEO role (owner, 2026-10-15) must leave every
 * existing role exactly where it was, and the CEO's stored ticks must resolve
 * to "sees everything listed, is never given a chat".
 */
const NEW = [
  'can_be_assigned',
  'view_chat_status_report',
  'view_busy_report',
  'view_chat_breakdown',
  'view_own_performance',
  'view_preferences',
] as const;

describe('switches added for the CEO role', () => {
  it('default to what each role had before', () => {
    // A role that reads all chats (so view_agent_reports by default) and works the inbox.
    const supervisor = effectivePrivileges(
      { use_chat: true, view_all_chats: true },
      'WeCare Supervisor',
    );
    for (const k of NEW) expect(supervisor[k], k).toBe(true);
    // Delete restaurants follows manage_restaurants, as it did inside it.
    expect(effectivePrivileges({ manage_restaurants: true }, 'Operations').delete_restaurants).toBe(
      true,
    );
    expect(supervisor.delete_restaurants).toBe(false);
    // An agent who sees only their own chats: no report tabs, still performance + preferences.
    const agent = effectivePrivileges({ use_chat: true }, 'WeCare Agent');
    expect(agent.view_chat_status_report).toBe(false);
    expect(agent.view_busy_report).toBe(false);
    expect(agent.view_own_performance).toBe(true);
    expect(agent.view_preferences).toBe(true);
    expect(agent.can_be_assigned).toBe(true);
  });

  it('a CEO set-up sees all chats but is never assigned, without the hidden pages', () => {
    const ceo = effectivePrivileges(
      {
        use_chat: true,
        view_all_chats: true,
        receive_chats: false,
        can_be_assigned: false,
        work_late_orders: false,
        view_own_performance: false,
        view_preferences: false,
        view_agent_dashboard: true,
        view_ops_dashboard: true,
        view_agent_reports: true,
        view_late_orders_report: false,
        view_chat_status_report: false,
        view_busy_report: false,
        view_chat_breakdown: false,
        delete_tickets: false,
        delete_compensation: false,
        manage_sla: false,
        manage_store_notifications: false,
        manage_restaurants: true,
        delete_restaurants: false,
      },
      'CEO',
    );
    expect(ceo.view_all_chats).toBe(true);
    expect(ceo.receive_chats).toBe(false);
    expect(ceo.can_be_assigned).toBe(false);
    expect(ceo.mark_busy).toBe(false); // Busy is for the three WeCare roles only
    expect(ceo.view_agent_dashboard && ceo.view_ops_dashboard).toBe(true);
    expect(ceo.view_chat_breakdown).toBe(false);
    expect(ceo.manage_restaurants && !ceo.delete_restaurants).toBe(true);
  });

  it('every switch is placed in a portal on the Roles page', () => {
    for (const k of [...PRIVILEGES, ...OWNER_PRIVILEGES]) {
      expect(['agent', 'admin'], k).toContain(PRIVILEGE_PORTAL[k]);
    }
  });
});
