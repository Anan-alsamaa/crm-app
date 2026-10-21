import { describe, expect, it } from 'vitest';
import { effectivePrivileges } from '@yiji/shared-types';
import { rolePrivileges } from '../src/auth/agent-jwt.js';

/* Busy is for the three WeCare roles only; "for the rest it must be off"
   (owner, 2026-10-13) - the Administrator included, although it otherwise
   holds every privilege. */
describe('mark_busy', () => {
  it.each(['WeCare Agent', 'WeCare Supervisor', 'WeCare Admin'])('%s has it by default', (role) => {
    expect(effectivePrivileges({}, role).mark_busy).toBe(true);
  });

  it.each(['Department Manager', 'Viewer', 'Operations', 'TV Screen'])(
    '%s does not by default',
    (role) => {
      expect(effectivePrivileges({}, role).mark_busy).toBe(false);
    },
  );

  it('a stored tick wins over the default', () => {
    expect(effectivePrivileges({ mark_busy: false }, 'WeCare Agent').mark_busy).toBe(false);
    expect(effectivePrivileges({ mark_busy: true }, 'Viewer').mark_busy).toBe(true);
  });

  /* Owner, 2026-10-22: the superuser holds everything except the WeCare
     floor's chat work - Busy, being routed chats, being a chat's assignee. */
  it('the row-less Administrator holds everything EXCEPT the WeCare chat work', () => {
    const p = rolePrivileges('Administrator', null);
    expect(p.mark_busy).toBe(false);
    expect(p.receive_chats).toBe(false);
    expect(p.can_be_assigned).toBe(false);
    expect(p.delete_chats).toBe(true);
    expect(p.manage_ticket_compensation).toBe(true);
    expect(p.assign_chats).toBe(true);
  });

  it('WeCare roles still receive chats and can be assigned', () => {
    expect(rolePrivileges('WeCare Agent', null).receive_chats).toBe(true);
    expect(rolePrivileges('WeCare Agent', null).can_be_assigned).toBe(true);
    expect(rolePrivileges('WeCare Supervisor', null).can_be_assigned).toBe(true);
  });
});
