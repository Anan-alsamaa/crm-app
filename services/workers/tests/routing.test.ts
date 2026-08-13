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
}) {
  const assign = vi.fn().mockResolvedValue(undefined);
  const schedule = vi.fn().mockResolvedValue(undefined);
  const recordOutcome = vi.fn().mockResolvedValue(undefined);
  const agentsByLoad = vi.fn().mockResolvedValue(over.roster ?? over.online ?? []);
  return {
    assign,
    schedule,
    recordOutcome,
    agentsByLoad,
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
      },
      schedule,
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

    it('leaves it with its owner when there is no second agent to try', async () => {
      // It used to null the assignee here. There being nobody else to ask is
      // not a reason to take the chat away from the one person who has it.
      const { d, assign, schedule } = deps({
        online: ['a1'],
        roster: ['a1'],
        convo: { id: 'c1', assigned_agent: 'a1', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'escalate', attemptedAgentIds: ['a1'] }), d);
      expect(assign).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
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
    it('hands the conversation ON rather than releasing it to nobody', async () => {
      const { d, assign } = deps({
        online: ['a1', 'a2', 'a3'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(assign).toHaveBeenCalledWith('c1', 'a3');
    });

    it('keeps it with the current owner once everyone has been tried', async () => {
      const { d, assign } = deps({
        online: ['a1', 'a2'],
        roster: ['a1', 'a2'],
        convo: { id: 'c1', assigned_agent: 'a2', assigned_team: null, status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(assign).not.toHaveBeenCalled();
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
