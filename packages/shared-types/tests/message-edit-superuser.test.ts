import { describe, expect, it } from 'vitest';
import { messageEditRefusal } from '../src/message-edit.js';

/* Owner, 2026-10-22: the Administrator may edit/delete ANY agent's reply -
   still inside the 15 minutes, never a customer's words or the welcome. */
const NOW = Date.parse('2026-10-22T10:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const reply = (minAgo: number) => ({
  sender_type: 'agent',
  sender_user: 'mohamed',
  is_internal_note: false,
  date_created: at(minAgo),
  deleted_at: null,
});
const admin = { kind: 'agent' as const, agentId: 'owner', superuser: true };

describe('the Administrator and other agents’ replies', () => {
  it('may change another agent’s reply inside the 15 minutes', () => {
    expect(messageEditRefusal(reply(5) as never, admin, NOW)).toBeNull();
  });

  it('keeps the 15-minute rule', () => {
    expect(messageEditRefusal(reply(16) as never, admin, NOW)).toBe('edit_window_closed');
  });

  it('never a customer’s message, an internal note, or the automatic welcome', () => {
    expect(messageEditRefusal({ ...reply(1), sender_type: 'customer' } as never, admin, NOW)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal({ ...reply(1), is_internal_note: true } as never, admin, NOW)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal({ ...reply(1), sender_user: null } as never, admin, NOW)).toBe(
      'not_own_message',
    );
  });

  it('every other agent is still limited to their own replies', () => {
    expect(messageEditRefusal(reply(1) as never, { kind: 'agent', agentId: 'sara' }, NOW)).toBe(
      'not_own_message',
    );
    expect(messageEditRefusal(reply(1) as never, 'mohamed', NOW)).toBeNull();
  });
});
