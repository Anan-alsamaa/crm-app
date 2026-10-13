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

  it('the row-less Administrator holds everything EXCEPT Busy', () => {
    const p = rolePrivileges('Administrator', null);
    expect(p.mark_busy).toBe(false);
    expect(p.receive_chats).toBe(true);
    expect(p.delete_chats).toBe(true);
  });
});
