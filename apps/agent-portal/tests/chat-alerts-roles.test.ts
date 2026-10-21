import { describe, expect, it } from 'vitest';
import { receivesChatAlerts } from '../src/lib/chat-alerts.js';

/* Owner, 2026-10-22: new-chat alerts are for the WeCare roles only. */
describe('receivesChatAlerts', () => {
  it('is true for the three WeCare roles, whatever the case or spacing', () => {
    for (const r of ['WeCare Agent', 'WeCare Supervisor', 'WeCare Admin', ' wecare agent ']) {
      expect(receivesChatAlerts(r)).toBe(true);
    }
  });

  it('is false for every other role, and for no role', () => {
    for (const r of [
      'Administrator',
      'Admin',
      'CEO',
      'Operations',
      'Viewer',
      '',
      null,
      undefined,
    ]) {
      expect(receivesChatAlerts(r)).toBe(false);
    }
  });
});
