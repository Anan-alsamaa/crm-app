/**
 * Two faults behind the Agent summary's blank / misplaced cells on production
 * (14-15 Oct 2026). Measured against live rows, not inferred.
 */
import { describe, it, expect } from 'vitest';
import {
  agentPerformance,
  ticketChatSession,
  ticketSolveSec,
  ticketSolveSpan,
  type ChatTiming,
  type TimingMessage,
} from '../src/index.js';

describe('ticketSolveSec — one rule for Agent summary and Ticket deadlines', () => {
  it("starts the clock at the customer's first chat message when the ticket came from a chat", () => {
    // Live ticket 030bf25e: chat opened 11:08:58, ticket raised 11:28:42 (server),
    // resolved_at 11:26:15 (agent PC, ~2.5 min behind). 17m17s, not 0 and not "—".
    const sec = ticketSolveSec({
      createdAt: '2026-10-15T11:28:42.551Z',
      resolvedAt: '2026-10-15T11:26:15.396Z',
      chatStartAt: '2026-10-15T11:08:58.758Z',
    });
    expect(sec).toBeCloseTo(17 * 60 + 16.638, 2);
  });

  it("uses the server's solve record when resolved_at runs behind the creation stamp", () => {
    // Live ticket 51417339 (no chat): created 13:39:24, browser resolved_at
    // 13:37:29, the revision that set it solved 13:40:01 -> 37s.
    const input = {
      createdAt: '2026-10-14T13:39:24.264Z',
      resolvedAt: '2026-10-14T13:37:29.639Z',
      solvedServerAt: '2026-10-14T13:40:01.002Z',
    };
    expect(ticketSolveSpan(input)?.endBasis).toBe('server');
    expect(ticketSolveSec(input)).toBeCloseTo(36.738, 2);
  });

  it('measures an ordinary ticket on the wall clock, or in working hours when given', () => {
    const plain = { createdAt: '2026-10-15T09:00:00.000Z', resolvedAt: '2026-10-15T10:00:00.000Z' };
    expect(ticketSolveSec(plain)).toBe(3600);
    // 2026-10-15 is a Thursday (day 4): only 09:00-09:30 of that hour is working time.
    const thu = { timezone: 'UTC', days: { '4': [['09:00', '09:30']] as [string, string][] } };
    expect(ticketSolveSec(plain, thu)).toBe(1800);
  });

  it('ignores a chat start that is not earlier than the ticket', () => {
    expect(
      ticketSolveSpan({
        createdAt: '2026-10-15T09:00:00.000Z',
        resolvedAt: '2026-10-15T10:00:00.000Z',
        chatStartAt: '2026-10-15T09:30:00.000Z',
      })?.startBasis,
    ).toBe('ticket');
  });

  it('is 0 only when every solve stamp is before the start and nothing corrects it', () => {
    expect(
      ticketSolveSec({
        createdAt: '2026-10-15T11:28:42.551Z',
        resolvedAt: '2026-10-15T11:26:15.396Z',
      }),
    ).toBe(0);
  });

  it('is null only when there is no start or no end', () => {
    expect(ticketSolveSec({ createdAt: '2026-10-15T09:00:00.000Z', resolvedAt: null })).toBeNull();
    expect(ticketSolveSec({ createdAt: null, resolvedAt: '2026-10-15T09:00:00.000Z' })).toBeNull();
    expect(
      ticketSolveSec({ createdAt: 'nonsense', resolvedAt: '2026-10-15T09:00:00.000Z' }),
    ).toBeNull();
  });
});

describe('ticketChatSession — the session the ticket was raised from', () => {
  const m = (date_created: string, sender_type: string, sender_user: string | null = null) =>
    ({ conversation: 'c', sender_type, date_created, sender_user }) as TimingMessage;

  it('skips an earlier session and a later one (one thread per contact)', () => {
    // Live conversation 0d390461 / ticket 859504b2 (raised 13:35:01).
    const msgs = [
      m('2026-10-13T23:59:19.373Z', 'customer'),
      m('2026-10-13T23:59:48.376Z', 'agent', 'a1'),
      m('2026-10-14T00:16:23.455Z', 'system'),
      m('2026-10-14T12:45:25.250Z', 'customer'),
      m('2026-10-14T12:45:25.701Z', 'agent', null), // automatic welcome
      m('2026-10-14T12:45:39.723Z', 'agent', 'a2'),
      m('2026-10-14T13:17:29.773Z', 'system'),
      m('2026-10-14T19:49:19.847Z', 'customer'),
      m('2026-10-14T19:52:46.640Z', 'agent', 'a3'),
    ];
    expect(ticketChatSession(msgs, '2026-10-14T13:35:01.515Z')).toEqual({
      customerAt: '2026-10-14T12:45:25.250Z',
      agentAt: '2026-10-14T12:45:39.723Z',
    });
  });

  it('a long silence starts a new session even without a closing notice', () => {
    // Live conversation of ticket 6fa6dfba: a 2 Oct chat, no closing notice,
    // then the 14 Oct one the ticket was raised from.
    const msgs = [
      m('2026-10-02T14:12:32.579Z', 'customer'),
      m('2026-10-02T14:18:27.784Z', 'agent', 'a1'),
      m('2026-10-14T20:11:04.029Z', 'customer'),
      m('2026-10-14T20:11:04.378Z', 'agent', null),
      m('2026-10-14T20:11:40.203Z', 'agent', 'a1'),
      m('2026-10-14T20:30:42.982Z', 'agent', 'a1'),
    ];
    expect(ticketChatSession(msgs, '2026-10-14T20:40:56.510Z')).toEqual({
      customerAt: '2026-10-14T20:11:04.029Z',
      agentAt: '2026-10-14T20:11:40.203Z',
    });
  });

  it('is null when the customer had not written before the ticket', () => {
    expect(
      ticketChatSession([m('2026-10-14T13:00:00.000Z', 'customer')], '2026-10-14T12:00:00.000Z'),
    ).toBeNull();
  });
});

describe('common chats are credited to whoever actually replied', () => {
  const chat = (over: Partial<ChatTiming>): ChatTiming => ({
    conversationId: 'c1',
    agentId: 'faisal',
    agentName: 'Faisal',
    firstCustomerAt: '2026-10-14T10:39:32.557Z',
    firstAgentAt: '2026-10-14T10:40:35.902Z',
    solvedAt: null,
    ...over,
  });

  it('does not credit the agent the ladder wrote "answered" against when a colleague replied', () => {
    // Live chat 4ca25986: routing says "Faisal broadcast answered", but every
    // reply in it was Shatha's and Faisal never wrote.
    const rows = agentPerformance([
      chat({ passedOn: true, takenBy: 'faisal', firstAgentBy: 'shatha' }),
    ]);
    const faisal = rows.find((r) => r.agentId === 'faisal')!;
    const shatha = rows.find((r) => r.agentId === 'shatha')!;
    expect(faisal.commonChats).toBe(0);
    expect(shatha.commonChats).toBe(1);
  });

  it('falls back to the routing history when the sender is unknown', () => {
    const rows = agentPerformance([
      chat({ passedOn: true, takenBy: 'faisal', firstAgentBy: null }),
    ]);
    expect(rows.find((r) => r.agentId === 'faisal')!.commonChats).toBe(1);
  });
});
