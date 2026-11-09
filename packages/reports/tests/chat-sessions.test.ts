import { describe, it, expect } from 'vitest';
import {
  chatSessions,
  sessionTimingRows,
  sessionRating,
  mahaSessionStats,
  type SessionMessage,
} from '../src/chat-sessions.js';
import { firstResponseSec, type ChatTiming } from '../src/agent-performance.js';

/* Production, conversation b08c00f5, 2026-11-05 (Riyadh = UTC+3). The customer
   wrote at 00:53, Mohamed answered at 01:27 (34 min), the chat was solved; the
   customer came back at 07:00 and Shatha answered at 08:20. */
const C = 'b08c00f5';
const msg = (
  at: string,
  sender_type: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({
  conversation: C,
  sender_type,
  date_created: at,
  sender_user: null,
  ...extra,
});
const THREAD: SessionMessage[] = [
  msg('2026-11-04T21:53:11.000Z', 'customer'),
  msg('2026-11-04T21:53:11.500Z', 'agent', { source: 'auto_welcome' }),
  msg('2026-11-04T21:53:51.000Z', 'customer'),
  msg('2026-11-04T22:07:34.000Z', 'customer'),
  msg('2026-11-04T22:27:28.000Z', 'agent', { sender_user: 'mohamed', source: 'typed' }),
  msg('2026-11-05T04:00:35.000Z', 'customer'),
  msg('2026-11-05T04:00:36.000Z', 'agent', { source: 'auto_welcome' }),
  msg('2026-11-05T05:20:01.000Z', 'agent', { sender_user: 'shatha', source: 'typed' }),
  msg('2026-11-05T05:25:50.000Z', 'agent', { sender_user: 'shatha', source: 'quick_reply' }),
];
const HOURS = {
  timezone: 'Asia/Riyadh',
  days: Object.fromEntries(
    ['0', '1', '2', '3', '4', '5', '6'].map((d) => [
      d,
      [
        ['00:00', '04:00'],
        ['09:00', '24:00'],
      ],
    ]),
  ),
} as never;
const CONV = {
  id: C,
  status: 'solved',
  assigned_agent: 'shatha',
  solved_at: '2026-11-05T05:30:00.000Z',
  date_created: '2026-11-04T21:53:11.000Z',
  initiated_by: 'customer',
};
const solved = (s: string | null) => s === 'solved';
const timing = (r: ReturnType<typeof sessionTimingRows>[number]): ChatTiming => ({
  conversationId: r.conversationId,
  agentId: r.agentId,
  agentName: r.agentId ?? 'General',
  firstCustomerAt: r.firstCustomerAt,
  firstAgentAt: r.firstAgentAt,
  firstAgentBy: r.firstAgentBy,
  solvedAt: r.solvedAt,
  businessHours: HOURS,
});

describe('chatSessions - a returning customer is two sessions, not one thread', () => {
  it('splits at the message the automatic welcome answers', () => {
    const s = chatSessions(THREAD).get(C)!;
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({
      firstCustomerAt: '2026-11-04T21:53:11.000Z',
      firstAgentAt: '2026-11-04T22:27:28.000Z',
      firstAgentBy: 'mohamed',
      isLatest: false,
    });
    expect(s[1]).toMatchObject({
      firstCustomerAt: '2026-11-05T04:00:35.000Z',
      firstAgentAt: '2026-11-05T05:20:01.000Z',
      firstAgentBy: 'shatha',
      isLatest: true,
    });
  });

  it('measures each reply on its own: Mohamed 34 min, Shatha 0 working minutes', () => {
    const rows = sessionTimingRows([CONV], THREAD, {}, solved);
    expect(rows.map((r) => r.agentId)).toEqual(['mohamed', 'shatha']);
    expect(Math.round(firstResponseSec(timing(rows[0]!))! / 60)).toBe(34);
    // 07:00 -> 08:20 Riyadh is before the 09:00 shift: no working time passed.
    expect(firstResponseSec(timing(rows[1]!))).toBe(0);
  });

  it('honours the gateway marker even when no welcome was sent', () => {
    const noWelcome = THREAD.filter((m) => m.source !== 'auto_welcome').map((m) =>
      m.date_created === '2026-11-05T04:00:35.000Z' ? { ...m, starts_session: true } : m,
    );
    expect(chatSessions(noWelcome).get(C)).toHaveLength(2);
  });

  it('never splits on a long silence - an overnight wait is ONE slow session', () => {
    const wait: SessionMessage[] = [
      msg('2026-11-05T01:00:00.000Z', 'customer'),
      msg('2026-11-05T01:00:01.000Z', 'agent', { source: 'auto_welcome' }),
      msg('2026-11-05T03:00:00.000Z', 'customer'),
      msg('2026-11-05T09:00:00.000Z', 'agent', { sender_user: 'a1' }),
    ];
    const s = chatSessions(wait).get(C)!;
    expect(s).toHaveLength(1);
    expect(s[0]!.firstAgentAt).toBe('2026-11-05T09:00:00.000Z');
  });

  it('a welcome long after a customer message does not open a session', () => {
    const late: SessionMessage[] = [
      msg('2026-11-05T01:00:00.000Z', 'customer'),
      msg('2026-11-05T01:00:01.000Z', 'agent', { source: 'auto_welcome' }),
      msg('2026-11-05T02:00:00.000Z', 'customer'),
      msg('2026-11-05T02:10:00.000Z', 'agent', { source: 'auto_welcome' }),
    ];
    expect(chatSessions(late).get(C)).toHaveLength(1);
  });
});

describe('sessionTimingRows', () => {
  it('puts each session on the day IT started, so the morning visit is in today', () => {
    const rows = sessionTimingRows(
      [CONV],
      THREAD,
      { from: '2026-11-05T02:00:00.000Z', to: '2026-11-05T20:59:59.999Z' },
      solved,
    );
    expect(rows.map((r) => r.agentId)).toEqual(['shatha']);
  });

  it('an earlier session counts as solved at its last message; the newest uses the status', () => {
    const rows = sessionTimingRows([CONV], THREAD, {}, solved);
    expect(rows[0]!.solvedAt).toBe('2026-11-04T22:27:28.000Z');
    expect(rows[1]!.solvedAt).toBe(CONV.solved_at);
    expect(rows.map((r) => r.sessionKey)).toEqual([`${C}#0`, `${C}#1`]);
  });

  it('only the first session can be an outreach', () => {
    const rows = sessionTimingRows([{ ...CONV, initiated_by: 'agent' }], THREAD, {}, solved);
    expect(rows.map((r) => r.initiatedBy)).toEqual(['agent', 'customer']);
  });

  it('a chat with no messages is still one row on its creation day', () => {
    const rows = sessionTimingRows([CONV], [], {}, solved);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstCustomerAt).toBeNull();
  });
});

describe('sessionRating - one rating, one session', () => {
  it('attaches a rating to the session it was given in, not to every session', () => {
    const rows = sessionTimingRows([CONV], THREAD, {}, solved);
    const ratings = [{ score: 5, at: '2026-11-05T05:40:00.000Z' }];
    expect(sessionRating(rows[0]!, ratings)).toBeNull();
    expect(sessionRating(rows[1]!, ratings)).toBe(5);
  });

  it('an undated rating goes to the newest session only', () => {
    const rows = sessionTimingRows([CONV], THREAD, {}, solved);
    const ratings = [{ score: 4, at: null }];
    expect(sessionRating(rows[0]!, ratings)).toBeNull();
    expect(sessionRating(rows[1]!, ratings)).toBe(4);
  });
});

describe('Maha (owner, 2026-11-09)', () => {
  const conv = {
    id: C,
    status: 'open',
    assigned_agent: 'agent-1',
    solved_at: null,
    date_created: '2026-11-09T10:00:00.000Z',
    initiated_by: 'customer',
  };
  const auto = (at: string, source: string) => msg(at, 'agent', { sender_user: null, source });
  const human = (at: string) => msg(at, 'agent', { sender_user: 'agent-1', source: 'typed' });
  const cust = (at: string) => msg(at, 'customer', { source: 'customer' });

  it('measures the agent from the HANDOVER, not the customer first message', () => {
    const messages = [
      cust('2026-11-09T10:00:00.000Z'),
      auto('2026-11-09T10:00:01.000Z', 'maha_intro'),
      auto('2026-11-09T10:00:05.000Z', 'maha'),
      cust('2026-11-09T10:10:00.000Z'),
      auto('2026-11-09T10:10:04.000Z', 'maha_handover'),
      human('2026-11-09T10:12:04.000Z'),
    ];
    const [row] = sessionTimingRows([conv], messages, {}, () => false);
    expect(row).toMatchObject({
      firstCustomerAt: '2026-11-09T10:10:04.000Z',
      firstAgentAt: '2026-11-09T10:12:04.000Z',
      firstAgentBy: 'agent-1',
    });
  });

  it('an agent who turned Maha off is measured from the customer message after her last answer', () => {
    const messages = [
      cust('2026-11-09T10:00:00.000Z'),
      auto('2026-11-09T10:00:01.000Z', 'maha_intro'),
      auto('2026-11-09T10:00:05.000Z', 'maha'),
      cust('2026-11-09T10:20:00.000Z'),
      auto('2026-11-09T10:21:00.000Z', 'agent_joined'),
      human('2026-11-09T10:21:00.500Z'),
    ];
    const [row] = sessionTimingRows([conv], messages, {}, () => false);
    expect(row!.firstCustomerAt).toBe('2026-11-09T10:20:00.000Z');
  });

  it('a session Maha resolved alone is nobody s to answer - not a row, counted for her', () => {
    const messages = [
      cust('2026-11-09T10:00:00.000Z'),
      auto('2026-11-09T10:00:01.000Z', 'maha_intro'),
      auto('2026-11-09T10:00:05.000Z', 'maha'),
    ];
    expect(sessionTimingRows([conv], messages, {}, () => false)).toEqual([]);
    expect(mahaSessionStats(messages, {})).toEqual({ taken: 1, handledByMaha: 1, handedOver: 0 });
  });

  it('counts a handover for Maha, and a session she never had not at all', () => {
    const handed = [
      cust('2026-11-09T10:00:00.000Z'),
      auto('2026-11-09T10:00:01.000Z', 'maha_intro'),
      auto('2026-11-09T10:00:04.000Z', 'maha_handover'),
      human('2026-11-09T10:01:00.000Z'),
    ];
    const plain = [
      { ...cust('2026-11-09T11:00:00.000Z'), conversation: 'other' },
      { ...human('2026-11-09T11:01:00.000Z'), conversation: 'other' },
    ];
    expect(mahaSessionStats([...handed, ...plain], {})).toEqual({
      taken: 1,
      handledByMaha: 0,
      handedOver: 1,
    });
  });

  it('a chat Maha never touched is measured exactly as before', () => {
    const messages = [cust('2026-11-09T10:00:00.000Z'), human('2026-11-09T10:03:00.000Z')];
    const [row] = sessionTimingRows([conv], messages, {}, () => false);
    expect(row!.firstCustomerAt).toBe('2026-11-09T10:00:00.000Z');
  });
});
