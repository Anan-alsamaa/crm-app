import { describe, it, expect } from 'vitest';
import { agentPerformance, type ChatTiming } from '../src/agent-performance.js';

/**
 * TWO "SULTAN" ROWS (owner-reported, 2026-10-26).
 *
 * Filtered to Sultan, Agent performance showed Sultan twice. One of Sultan's
 * chats had its first reply sent by a colleague; the colleague correctly got a
 * row for that reply, but the row was named after the chat's ASSIGNEE.
 */
const chat = (over: Partial<ChatTiming>): ChatTiming => ({
  conversationId: 'c',
  agentId: 'sultan',
  agentName: 'Sultan',
  firstCustomerAt: '2026-10-25T20:00:00Z',
  firstAgentAt: '2026-10-25T20:01:00Z',
  solvedAt: null,
  ...over,
});

describe('a row for an agent who only replied', () => {
  const chats = [
    chat({ conversationId: 'a', firstAgentBy: 'sultan' }),
    // Sultan's chat, first answered by Nada.
    chat({ conversationId: 'b', firstAgentBy: 'nada' }),
  ];

  it("is named after the replier, never the chat's assignee", () => {
    const rows = agentPerformance(chats, undefined, new Map([['nada', 'Nada']]));
    expect(rows.map((r) => [r.agentId, r.agentName]).sort()).toEqual([
      ['nada', 'Nada'],
      ['sultan', 'Sultan'],
    ]);
  });

  it('falls back to the id, not to somebody else, when no name is known', () => {
    const rows = agentPerformance(chats);
    expect(rows.find((r) => r.agentId === 'nada')?.agentName).toBe('nada');
  });
});
