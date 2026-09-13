import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRouting } from '../src/routing.js';
import { ROUTING_FIRST_WAIT_MS, ROUTING_SECOND_WAIT_MS, type RoutingJob } from '@yiji/shared-types';

/**
 * The escalation ladder decides who answers a customer, so its failure modes are
 * expensive and invisible: a conversation silently stuck with one agent, one
 * that escalates away from an agent who WAS replying, or one left owned by
 * nobody. All three look fine in a manual click-through, which is why they are
 * pinned here instead.
 */

/** Redis stand-in: a sorted set is just an ordered list of ids for our purposes. */
function fakeRedis(onlineIdleFirst: string[]) {
  return {
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zrange: vi.fn().mockResolvedValue(onlineIdleFirst),
    // Membership, for the reclaim stage's "did they come back?" check. A score
    // exists exactly for the agents in the online set.
    zscore: vi
      .fn()
      .mockImplementation(async (_k: string, id: string) =>
        onlineIdleFirst.includes(id) ? '1' : null,
      ),
  } as never;
}

interface Convo {
  id: string;
  assigned_agent: string | null;
  assigned_team: string | null;
  status: string;
}

function deps(over: {
  online?: string[];
  /** Eligible agents, least-loaded first — what agentsByLoad returns. */
  roster?: string[];
  convo?: Convo | null;
  outbound?: number;
  /** Who the supervisor alert would reach. Empty models a real prod risk. */
  supervisors?: string[];
}) {
  const assign = vi.fn().mockResolvedValue(undefined);
  const schedule = vi.fn().mockResolvedValue(undefined);
  const recordOutcome = vi.fn().mockResolvedValue(undefined);
  const agentsByLoad = vi.fn().mockResolvedValue(over.roster ?? over.online ?? []);
  // Who hears about a chat with nobody left to offer it to, and the alert
  // itself. Defaulted so every existing test keeps working untouched.
  const supervisorIds = vi.fn().mockResolvedValue(over.supervisors ?? ['sup-1']);
  const notify = vi.fn().mockResolvedValue(undefined);
  return {
    assign,
    schedule,
    recordOutcome,
    agentsByLoad,
    supervisorIds,
    notify,
    d: {
      redis: fakeRedis(over.online ?? []),
      directus: {
        getConversation: vi
          .fn()
          .mockResolvedValue(
            over.convo === undefined
              ? { id: 'c1', assigned_agent: null, assigned_team: null, status: 'open' }
              : over.convo,
          ),
        countOutboundMessages: vi.fn().mockResolvedValue(over.outbound ?? 0),
        assign,
        agentsByLoad,
        recordOutcome,
        supervisorIds,
      },
      schedule,
      notify,
      log: () => undefined,
    },
  };
}

const job = (o: Partial<RoutingJob> = {}): RoutingJob => ({
  conversationId: 'c1',
  stage: 'assign',
  attemptedAgentIds: [],
  outboundCountAtSchedule: 0,
  ...o,
});

describe('auto-assignment ladder', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('assign', () => {
    it('gives the conversation to the idlest online agent', async () => {
      const { d, assign, schedule } = deps({ online: ['idle-longest', 'busy'] });
      await handleRouting(job(), d);
      expect(assign).toHaveBeenCalledWith('c1', 'idle-longest');
      // And arms the escalation timer.
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'escalate', attemptedAgentIds: ['idle-longest'] }),
        ROUTING_FIRST_WAIT_MS,
      );
    });

    it('assigns to the LEAST LOADED agent when nobody is online', async () => {
      // It used to leave the chat unassigned here. A chat with an owner who is
      // away is found when they log in; a chat with no owner is found by
      // nobody, which is the failure the whole ladder exists to prevent.
      const { d, assign } = deps({ online: [], roster: ['quietest', 'busiest'] });
      await handleRouting(job(), d);
      expect(assign).toHaveBeenCalledWith('c1', 'quietest');
    });

    it('says so loudly when there is no agent at all to assign to', async () => {
      // A configuration problem, not a routing decision — and the one case
      // where a chat legitimately has no owner.
      const { d, assign, schedule } = deps({ online: [], roster: [] });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    });

    it('will not hand a chat to somebody online who is not eligible', async () => {
      /**
       * The roster is empty (no Agent-role account is active) but an
       * Administrator is holding a socket. An empty eligible list used to be
       * read as "no restriction", so presence alone decided and the chat landed
       * on the admin — the same failure as routing to a service account,
       * reached by a different door. Nobody eligible must mean nobody.
       */
      const { d, assign, schedule } = deps({ online: ['administrator'], roster: [] });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
      // Left in the unassigned pool, where any agent can see and rescue it.
      expect(schedule).not.toHaveBeenCalled();
    });

    it('stands down if a human already assigned it', async () => {
      const { d, assign } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: 'someone', assigned_team: null, status: 'open' },
      });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
    });

    it('ignores conversations that are already finished', async () => {
      const { d, assign } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: null, assigned_team: null, status: 'closed' },
      });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('teams — the shift handover', () => {
    it('offers a team chat only to that team', async () => {
      // The night shift hands over to the day shift. Picking the idlest agent
      // across the company would hand it straight back.
      const { d, assign, agentsByLoad } = deps({
        online: ['night-1', 'day-1'],
        roster: ['day-1', 'day-2'],
        convo: { id: 'c1', assigned_agent: null, assigned_team: 'day-shift', status: 'open' },
      });
      await handleRouting(job(), d);
      expect(agentsByLoad).toHaveBeenCalledWith('day-shift');
      expect(assign).toHaveBeenCalledWith('c1', 'day-1');
    });

    it('does not hand a team chat to an online agent outside the team', async () => {
      const { d, assign } = deps({
        online: ['night-1'],
        roster: ['day-1', 'day-2'],
        convo: { id: 'c1', assigned_agent: null, assigned_team: 'day-shift', status: 'open' },
      });
      await handleRouting(job(), d);
      // Nobody on the team is online, so it falls back to the team's own
      // least-loaded member — never to the passer-by.
      expect(assign).toHaveBeenCalledWith('c1', 'day-1');
    });

    it('asks for the whole roster when the chat has no team', async () => {
      const { d, agentsByLoad } = deps({ online: ['a1'] });
      await handleRouting(job(), d);
      expect(agentsByLoad).toHaveBeenCalledWith(null);
    });
  });

  describe('escalate', () => {
    it('cancels when the agent replied', async () => {
      // Outbound count moved past the value captured when the timer was set.
      const { d, assign } = deps({
        online: ['a2'],
        convo: { id: 'c1', assigned_agent: 'a1', assigned_team: null, status: 'open' },
        outbound: 3,
      });
      await handleRouting(
        job({ stage: 'escalate', attemptedAgentIds: ['a1'], outboundCountAtSchedule: 2 }),
        d,
      );
      expect(assign).not.toHaveBeenCalled();
    });

    it('hands to the next agent, never back to the one who stalled', async () => {
      const { d, assign, schedule } = deps({
        online: ['a1', 'a2'],
        convo: { id: 'c1', assigned_agent: 'a1', assigned_team: null, status: 'open' },
        outbound: 2,
      });
      await handleRouting(
        job({ stage: 'escalate', attemptedAgentIds: ['a1'], outboundCountAtSchedule: 2 }),
        d,
      );
      expect(assign).toHaveBeenCalledWith('c1', 'a2');
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }),
        ROUTING_SECOND_WAIT_MS,
      );
    });

    it('releases it to every agent when there is no second agent to try', async () => {
      /*
       * THE RULE CHANGED (owner, 2026-09-13), and this test changed with it.
       *
       * It used to assert the chat STAYED with its owner, on the reasoning that
       * nobody else to ask is not a reason to take it away. In practice that is
       * the single-agent case — the common one out of hours — and leaving it
       * owned hid it: an owned chat is filtered out of every "unassigned" view,
       * so the one person who missed it was also the only person who could see
       * it.
       *
       * Unassigned does not take it away from them; it opens it up. They still
       * see it, and now so does everyone else.
       */
      const { d, assign, schedule, notify } = deps({
        online: ['a1'],
        roster: ['a1'],
        convo: { id: 'c1', assigned_agent: 'a1', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'escalate', attemptedAgentIds: ['a1'] }), d);
      expect(assign).toHaveBeenCalledWith('c1', null);
      // The ladder stops here: there is no rung left to schedule.
      expect(schedule).not.toHaveBeenCalled();
      // And somebody is told, because nobody is watching this state.
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'sup-1', conversationId: 'c1' }),
      );
    });

    it('stands down when a human reassigned it mid-ladder', async () => {
      const { d, assign } = deps({
        online: ['a2'],
        convo: { id: 'c1', assigned_agent: 'a-human-picked', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'escalate', attemptedAgentIds: ['a1'] }), d);
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('broadcast — the last rung', () => {
    /*
     * THE RULE (owner, 2026-09-12): first agent 60s, next-most-free 30s, then
     * the chat is shown to EVERY logged-in agent so whoever is free takes it.
     *
     * This used to hand the last rung to a third NAMED agent instead, on the
     * reasoning that an unowned chat is a chat nobody answers. That is a real
     * concern but it was not the specified behaviour, and it failed worse: with
     * four agents the ladder never reached the fourth, and the customer waited
     * on one person who had already passed twice.
     *
     * Unassigned is VISIBLE, not lost — the inbox query admits
     * `assigned_agent _null` for every agent.
     */
    it('RELEASES the chat to every agent, even when others are untried', async () => {
      const { d, assign } = deps({
        online: ['a1', 'a2', 'a3'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(assign).toHaveBeenCalledWith('c1', null);
    });

    it('releases it once everyone has been tried, rather than parking it', async () => {
      // The worst previous outcome: it stayed with the agent who had already
      // ignored it, and no one else could see that it needed answering.
      const { d, assign } = deps({
        online: ['a1', 'a2'],
        roster: ['a1', 'a2'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(assign).toHaveBeenCalledWith('c1', null);
    });

    it('records the miss ONCE, against the agent who was holding it', async () => {
      // Released-to-the-pool must still be attributable, and must not
      // double-count the same agent in the routing report.
      const { d, recordOutcome } = deps({
        online: ['a1', 'a2'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      const forA2 = recordOutcome.mock.calls.filter((c) => c[0]?.agentId === 'a2');
      expect(forA2).toHaveLength(1);
      expect(forA2[0]![0]).toMatchObject({ outcome: 'missed', stage: 'broadcast' });
    });

    it('does nothing if the second agent replied in time', async () => {
      const { d, assign } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 5,
      });
      await handleRouting(
        job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'], outboundCountAtSchedule: 4 }),
        d,
      );
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('outcome recording (the source of the miss-rate metric)', () => {
    it('records a MISS against the agent who let the timer expire', async () => {
      const { d, recordOutcome } = deps({
        online: ['a1', 'a2'],
        convo: { id: 'c1', assigned_agent: 'a1', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'escalate', attemptedAgentIds: ['a1'] }), d);
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1', outcome: 'missed', conversationId: 'c1' }),
      );
    });

    it('records ANSWERED when the agent replied before the timer', async () => {
      const { d, recordOutcome } = deps({
        online: ['a2'],
        convo: { id: 'c1', assigned_agent: 'a1', assigned_team: null, status: 'open' },
        outbound: 3,
      });
      await handleRouting(
        job({ stage: 'escalate', attemptedAgentIds: ['a1'], outboundCountAtSchedule: 2 }),
        d,
      );
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1', outcome: 'answered' }),
      );
    });

    it('attributes the miss to the agent who HELD it, not the next in line', async () => {
      // The bug this guards: recording against the incoming agent would blame
      // whoever picks up the escalation for the previous agent's silence.
      const { d, recordOutcome } = deps({
        online: ['a1', 'a2', 'a3'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a2', outcome: 'missed' }),
      );
    });
  });
});

/**
 * RECLAIM — the owner's connection dropped mid-conversation.
 *
 * REPORTED BY THE OWNER (2026-09-10): an agent goes offline partway through a
 * live chat and the conversation stays pinned to them. Nothing rescued it — the
 * ladder stands down the instant it sees an owner, so even the customer's next
 * message left the chat with a ghost until a human noticed.
 *
 * The delay before this runs is a GRACE PERIOD, not a countdown: everything is
 * re-checked here, because in 90 seconds the agent may have reloaded, crossed a
 * network boundary, or been handed the chat by someone else.
 */
describe('reclaim: the assigned agent went offline', () => {
  const job = (over: Partial<RoutingJob> = {}): RoutingJob => ({
    conversationId: 'c1',
    stage: 'reclaim',
    previousAgentId: 'gone',
    attemptedAgentIds: [],
    outboundCountAtSchedule: 0,
    ...over,
  });
  const owned = { id: 'c1', assigned_agent: 'gone', assigned_team: null, status: 'open' };

  it('moves the chat to the idlest ONLINE agent', async () => {
    // The same rule that assigns a new chat: online first, idlest of those.
    const t = deps({ convo: owned, online: ['idlest', 'busier'], roster: ['busier', 'idlest'] });
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', 'idlest');
  });

  it('NEVER hands it back to the agent who vanished', async () => {
    // Even if they somehow top the roster, they are the one person who cannot
    // take it — they are the reason it is moving.
    const t = deps({ convo: owned, online: ['other'], roster: ['gone', 'other'] });
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', 'other');
  });

  it('KEEPS the chat when the agent signed back in inside the window', async () => {
    // The whole reason for the delay. Logging back in must not cost an agent
    // the conversation they are in the middle of.
    const t = deps({ convo: owned, online: ['gone', 'other'], roster: ['other'] });
    await handleRouting(job(), t.d);
    expect(t.assign).not.toHaveBeenCalled();
  });

  it('KEEPS the chat for an agent who is signed in but has not TYPED', async () => {
    /*
     * THE OWNER'S RULE (2026-09-10): a chat moves only if the agent logged out
     * and did not come back within 90 s — never because they went quiet.
     *
     * The presence score is last-activity, refreshed only on sending a message,
     * so an agent reading rather than typing falls past the TTL. Sweeping it
     * here (as the assignment path does) would take a live conversation off
     * somebody sitting at their desk. Membership, not recency, decides.
     */
    const t = deps({ convo: owned, online: ['gone'], roster: ['other'] });
    // A stale score: signed in, silent far longer than the TTL.
    (t.d.redis as unknown as { zscore: ReturnType<typeof vi.fn> }).zscore = vi
      .fn()
      .mockResolvedValue('1');
    await handleRouting(job(), t.d);
    expect(t.assign).not.toHaveBeenCalled();
  });

  it('does NOT sweep the presence set when checking the previous owner', async () => {
    // The sweep is what conflates "quiet" with "gone". Asserting its absence
    // pins the distinction, because reintroducing it would still pass every
    // other test here.
    const t = deps({ convo: owned, online: ['gone'], roster: ['other'] });
    const redis = t.d.redis as unknown as { zremrangebyscore: ReturnType<typeof vi.fn> };
    redis.zremrangebyscore = vi.fn().mockResolvedValue(0);
    await handleRouting(job(), t.d);
    expect(redis.zremrangebyscore).not.toHaveBeenCalled();
  });

  it('stands down when a HUMAN already moved it', async () => {
    // Somebody made a deliberate choice while the timer was pending. That
    // outranks anything this job would decide.
    const t = deps({
      convo: { ...owned, assigned_agent: 'chosen-by-a-human' },
      online: ['someone'],
      roster: ['someone'],
    });
    await handleRouting(job(), t.d);
    expect(t.assign).not.toHaveBeenCalled();
  });

  it('releases to the POOL when nobody can take it', async () => {
    // Leaving it with an offline agent hides it. Unassigned makes it visible to
    // every agent, which is the same choice `assign` makes with an empty roster.
    const t = deps({ convo: owned, online: [], roster: [] });
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', null);
  });

  it('MEASURES every handover', async () => {
    // The owner asked for this to be tracked. `routing_events` is what the
    // reports already read.
    const t = deps({ convo: owned, online: ['taker'], roster: ['taker'] });
    await handleRouting(job(), t.d);
    expect(t.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        agentId: 'gone',
        outcome: 'missed',
        stage: 'reclaim',
      }),
    );
  });

  it('records the miss even when the chat goes to the pool', async () => {
    const t = deps({ convo: owned, online: [], roster: [] });
    await handleRouting(job(), t.d);
    expect(t.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'gone', stage: 'reclaim' }),
    );
  });

  it('does nothing to a chat that is already solved', async () => {
    const t = deps({ convo: { ...owned, status: 'solved' }, online: ['x'], roster: ['x'] });
    await handleRouting(job(), t.d);
    expect(t.assign).not.toHaveBeenCalled();
  });

  it('ignores a reclaim with no previous owner rather than guessing', async () => {
    const t = deps({ convo: owned, online: ['x'], roster: ['x'] });
    await handleRouting(job({ previousAgentId: undefined }), t.d);
    expect(t.assign).not.toHaveBeenCalled();
  });

  it('does not start an escalation ladder for a reclaimed chat', async () => {
    // A reclaim is a handover, not a fresh offer: the customer is mid-conversation
    // and the new owner should not be put on a 60-second miss timer.
    const t = deps({ convo: owned, online: ['taker'], roster: ['taker'] });
    await handleRouting(job(), t.d);
    expect(t.schedule).not.toHaveBeenCalled();
  });
});

/**
 * A ROSTER TOO SMALL TO ESCALATE.
 *
 * REPORTED FROM PRODUCTION (WeCare, 2026-09-10): "auto-assignment is not
 * working — it assigns to one agent, and if they don't reply it does not move
 * on." The routing was correct. Production had exactly ONE user in a routable
 * role at the time, so `assign` gave the chat to them and `escalate` had nobody
 * left to offer it to.
 *
 * The behaviour is right and must not change: a chat with one possible owner
 * stays with them rather than being churned. What was wrong is that the system
 * said "everyone tried" — a sentence that reads identically with a roster of
 * one or of twenty, and left a correct ladder looking broken.
 */
describe('escalating with too few agents', () => {
  const owned = { id: 'c1', assigned_agent: 'only-one', assigned_team: null, status: 'open' };
  const job = (over: Partial<RoutingJob> = {}): RoutingJob => ({
    conversationId: 'c1',
    stage: 'escalate',
    attemptedAgentIds: ['only-one'],
    outboundCountAtSchedule: 0,
    ...over,
  });

  it('RELEASES the chat to everyone when there is nobody else, and alerts', async () => {
    // Was 'KEEPS the chat ... never unassigns it'. Reversed deliberately: see
    // the escalate test above for why holding it hid the chat from the team.
    const t = deps({ convo: owned, online: ['only-one'], roster: ['only-one'] });
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', null);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('alerts EVERY supervisor, not just the first', async () => {
    const t = deps({
      convo: owned,
      online: ['only-one'],
      roster: ['only-one'],
      supervisors: ['sup-1', 'sup-2', 'sup-3'],
    });
    await handleRouting(job(), t.d);
    expect(t.notify).toHaveBeenCalledTimes(3);
  });

  it('still releases the chat when there is nobody to alert', async () => {
    /*
     * Production has ZERO `WeCare Supervisor` accounts, so this is not a
     * hypothetical. The release is what the customer feels; the alert is
     * secondary and must never be able to block it.
     */
    const logged: string[] = [];
    const t = deps({ convo: owned, online: ['only-one'], roster: ['only-one'], supervisors: [] });
    (t.d as { log: (m: string, x?: unknown) => void }).log = (m) => logged.push(m);
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', null);
    expect(t.notify).not.toHaveBeenCalled();
    // Said out loud: an alert nobody receives must not look like one that was sent.
    expect(logged.join(' ')).toMatch(/nobody to alert/i);
  });

  it('still releases the chat when the alert itself fails', async () => {
    const t = deps({ convo: owned, online: ['only-one'], roster: ['only-one'] });
    t.notify.mockRejectedValue(new Error('notifications queue is down'));
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', null);
  });

  it('says the ROSTER is the problem, not that everyone was tried', async () => {
    /*
     * The diagnostic that was missing. Without it the only evidence is a log
     * line that sounds like normal exhaustion, so the next person to hit this
     * re-investigates the ladder instead of the roster.
     */
    const logged: string[] = [];
    const t = deps({ convo: owned, online: ['only-one'], roster: ['only-one'] });
    (t.d as { log: (m: string, x?: unknown) => void }).log = (m) => logged.push(m);
    await handleRouting(job(), t.d);
    expect(logged.join(' ')).toMatch(/ROSTER TOO SMALL/);
  });

  it('still escalates normally the moment a second agent exists', async () => {
    // The same conversation, the same job — one more agent on the roster is the
    // whole difference between "broken" and "working".
    const t = deps({
      convo: owned,
      online: ['only-one', 'second'],
      roster: ['only-one', 'second'],
    });
    await handleRouting(job(), t.d);
    expect(t.assign).toHaveBeenCalledWith('c1', 'second');
  });

  it('reports exhaustion normally when the roster really was worked through', async () => {
    // Three agents, all three already offered it: that IS "everyone tried", and
    // must not be mislabelled a configuration problem.
    const logged: string[] = [];
    const t = deps({
      convo: { ...owned, assigned_agent: 'c' },
      online: [],
      roster: ['a', 'b', 'c'],
    });
    (t.d as { log: (m: string, x?: unknown) => void }).log = (m) => logged.push(m);
    await handleRouting(job({ attemptedAgentIds: ['a', 'b', 'c'] }), t.d);
    expect(logged.join(' ')).toMatch(/everyone available has been tried/);
    expect(logged.join(' ')).not.toMatch(/ROSTER TOO SMALL/);
  });
});
