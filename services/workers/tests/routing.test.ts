import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRouting } from '../src/routing.js';
import { ROUTING_FIRST_WAIT_MS, ROUTING_SECOND_WAIT_MS, type RoutingJob } from '@yiji/shared-types';

/**
 * The escalation ladder decides who answers a customer, so its failure modes are
 * expensive and invisible: a conversation silently stuck with one agent, or one
 * that escalates away from an agent who WAS replying. Both look fine in a manual
 * click-through, which is why they are pinned here instead.
 */

/** Redis stand-in: a sorted set is just an ordered list of ids for our purposes. */
function fakeRedis(onlineIdleFirst: string[]) {
  return {
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zrange: vi.fn().mockResolvedValue(onlineIdleFirst),
  } as never;
}

function deps(over: {
  online?: string[];
  convo?: { id: string; assigned_agent: string | null; status: string } | null;
  outbound?: number;
}) {
  const assign = vi.fn().mockResolvedValue(undefined);
  const schedule = vi.fn().mockResolvedValue(undefined);
  const recordOutcome = vi.fn().mockResolvedValue(undefined);
  return {
    assign,
    schedule,
    recordOutcome,
    d: {
      redis: fakeRedis(over.online ?? []),
      directus: {
        getConversation: vi
          .fn()
          .mockResolvedValue(
            over.convo === undefined
              ? { id: 'c1', assigned_agent: null, status: 'open' }
              : over.convo,
          ),
        countOutboundMessages: vi.fn().mockResolvedValue(over.outbound ?? 0),
        assign,
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

    it('leaves it OPEN TO ALL when nobody is online', async () => {
      // Assigning to an offline agent would hide the conversation until they
      // happen to log in — worse than leaving it visible to everyone.
      const { d, assign, schedule } = deps({ online: [] });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    });

    it('stands down if a human already assigned it', async () => {
      const { d, assign } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: 'someone', status: 'open' },
      });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
    });

    it('ignores conversations that are already finished', async () => {
      const { d, assign } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: null, status: 'closed' },
      });
      await handleRouting(job(), d);
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('escalate', () => {
    it('cancels when the agent replied', async () => {
      // Outbound count moved past the value captured when the timer was set.
      const { d, assign } = deps({
        online: ['a2'],
        convo: { id: 'c1', assigned_agent: 'a1', status: 'open' },
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
        convo: { id: 'c1', assigned_agent: 'a1', status: 'open' },
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

    it('releases to all when there is no second agent to try', async () => {
      const { d, assign, schedule } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: 'a1', status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'escalate', attemptedAgentIds: ['a1'] }), d);
      expect(assign).toHaveBeenCalledWith('c1', null);
      // No point waiting out a timer that cannot change the outcome.
      expect(schedule).not.toHaveBeenCalled();
    });

    it('stands down when a human reassigned it mid-ladder', async () => {
      const { d, assign } = deps({
        online: ['a2'],
        convo: { id: 'c1', assigned_agent: 'a-human-picked', status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'escalate', attemptedAgentIds: ['a1'] }), d);
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('releases the conversation to every agent', async () => {
      const { d, assign } = deps({
        online: ['a1', 'a2'],
        convo: { id: 'c1', assigned_agent: 'a2', status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(assign).toHaveBeenCalledWith('c1', null);
    });

    it('does nothing if the second agent replied in time', async () => {
      const { d, assign } = deps({
        online: ['a1'],
        convo: { id: 'c1', assigned_agent: 'a2', status: 'open' },
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
        convo: { id: 'c1', assigned_agent: 'a1', status: 'open' },
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
        convo: { id: 'c1', assigned_agent: 'a1', status: 'open' },
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
        convo: { id: 'c1', assigned_agent: 'a2', status: 'open' },
        outbound: 0,
      });
      await handleRouting(job({ stage: 'broadcast', attemptedAgentIds: ['a1', 'a2'] }), d);
      expect(recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a2', outcome: 'missed' }),
      );
    });
  });
});
