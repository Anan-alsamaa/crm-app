/**
 * Auto-assignment: give a new conversation to ONE agent, escalate if they stall.
 *
 * Without this every agent sees every incoming chat, which is the classic
 * diffusion-of-responsibility failure — three agents each assume another is
 * taking it, and the customer waits. Assigning to a named agent fixes that, but
 * creates the opposite risk: a single unavailable agent now blocks the queue. The
 * escalation ladder exists for exactly that.
 *
 *   assign     pick the idlest ONLINE agent, hand it over
 *   escalate   no reply in 60s → hand to the next idlest, skipping whoever failed
 *   broadcast  no reply in a further 30s → hand to the least-loaded agent
 *
 * EVERY conversation ends up owned. The ladder used to fall back to "release to
 * the whole pool" — writing a null assignee — in two places: when nobody was
 * online, and at the end of the ladder. Both recreate the exact failure the
 * feature exists to prevent, so both are gone. When no agent is online the chat
 * goes to whoever currently holds the fewest open ones; they find it waiting
 * when they log in, which is strictly better than nobody finding it at all.
 *
 * TEAMS scope the candidates. A chat assigned to a team is a handover — the
 * night shift passing work to the day shift — so the ladder only ever offers it
 * to agents on that team; picking the idlest agent across the whole company
 * would hand it straight back to the shift that just handed it over.
 *
 * "Replied" is detected by comparing the OUTBOUND message count against the count
 * captured when the timer was scheduled. Timestamps would need the gateway and
 * this service to agree on a clock; a counter needs no such agreement.
 *
 * Manual assignment always wins: if the conversation's assignee changed to
 * somebody this ladder did not choose, a human intervened and the ladder stops.
 */
import type { Redis, Cluster } from 'ioredis';
import { ROUTING_FIRST_WAIT_MS, ROUTING_SECOND_WAIT_MS, type RoutingJob } from '@yiji/shared-types';

/** Same key the gateway writes; see services/socket-gateway/src/presence-store.ts. */
const PRESENCE_KEY = 'presence:agents';
const PRESENCE_TTL_MS = 90_000;

export interface RoutingDeps {
  redis: Redis | Cluster;
  /** Minimal Directus surface, injected so this stays unit-testable. */
  directus: {
    getConversation(id: string): Promise<{
      id: string;
      assigned_agent: string | null;
      assigned_team: string | null;
      status: string;
    } | null>;
    countOutboundMessages(conversationId: string): Promise<number>;
    assign(conversationId: string, agentId: string): Promise<void>;
    /**
     * Agent ids eligible for this conversation, LEAST BUSY FIRST, where "busy"
     * is their count of open conversations. Scoped to `teamId` when the chat
     * carries one.
     *
     * This is the offline fallback: presence answers "who is here", this
     * answers "who should have it anyway". Ordering by load rather than at
     * random matters because the fallback fires exactly when the team is
     * thinnest — out of hours — and a random pick concentrates a night's
     * backlog on whoever the shuffle favours.
     */
    agentsByLoad(teamId: string | null): Promise<string[]>;
    /**
     * Append the outcome of one offer. This is the ONLY place the system learns
     * that an agent was given a conversation and did not answer it — the ladder
     * silently moves on, so without a record "missed" is unmeasurable after the
     * fact.
     */
    recordOutcome(row: {
      conversationId: string;
      agentId: string;
      outcome: 'answered' | 'missed';
      stage: RoutingJob['stage'];
      secondsHeld: number;
    }): Promise<void>;
  };
  /** Enqueue the next stage after `delayMs`. */
  schedule(job: RoutingJob, delayMs: number): Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Who should get this conversation next.
 *
 * Online agents first, idlest first — someone at their desk answers sooner than
 * someone who is not. Then, only if that comes up empty, the least-loaded agent
 * whether or not they are online, because a chat with an owner who is currently
 * away still gets found; a chat with no owner gets found by nobody.
 *
 * `eligible` is the team roster when the chat has a team, and everyone
 * otherwise. Passing it in (rather than filtering afterwards) is what stops a
 * team handover being answered by the shift that handed it over.
 */
async function nextAgent(
  redis: Redis | Cluster,
  attempted: string[],
  eligible: string[],
): Promise<string | null> {
  const skip = new Set(attempted);
  const allowed = eligible.length > 0 ? new Set(eligible) : null;

  await redis.zremrangebyscore(PRESENCE_KEY, '-inf', Date.now() - PRESENCE_TTL_MS);
  const online = await redis.zrange(PRESENCE_KEY, 0, -1);
  const onlineHit = online.find((id) => !skip.has(id) && (!allowed || allowed.has(id)));
  if (onlineHit) return onlineHit;

  // Nobody online (or nobody online on this team). `eligible` is already
  // ordered least-loaded first.
  return eligible.find((id) => !skip.has(id)) ?? null;
}

export async function handleRouting(job: RoutingJob, deps: RoutingDeps): Promise<void> {
  const { redis, directus, schedule, log } = deps;
  const convo = await directus.getConversation(job.conversationId);

  // Gone, or already wrapped up — nothing to route.
  if (!convo || convo.status === 'closed' || convo.status === 'resolved') {
    log('routing: conversation not routable', { id: job.conversationId });
    return;
  }

  // The pool this chat may be offered to: its team's roster, or everyone.
  const eligible = await directus.agentsByLoad(convo.assigned_team);

  if (job.stage === 'assign') {
    // Someone already owns it (manual assignment, or a human grabbed it first).
    if (convo.assigned_agent) {
      log('routing: already assigned, standing down', { id: convo.id });
      return;
    }
    const agent = await nextAgent(redis, job.attemptedAgentIds, eligible);
    if (!agent) {
      // No agents exist at all (or none on the team). Nothing to assign to —
      // this is a configuration problem, not a routing decision, so say so
      // rather than silently leaving a chat nobody owns.
      log('routing: NO ELIGIBLE AGENTS — conversation left unowned', {
        id: convo.id,
        team: convo.assigned_team,
      });
      return;
    }
    await directus.assign(convo.id, agent);
    const outbound = await directus.countOutboundMessages(convo.id);
    await schedule(
      {
        conversationId: convo.id,
        stage: 'escalate',
        attemptedAgentIds: [...job.attemptedAgentIds, agent],
        outboundCountAtSchedule: outbound,
      },
      ROUTING_FIRST_WAIT_MS,
    );
    log('routing: assigned', { id: convo.id, agent });
    return;
  }

  // --- escalate / broadcast both first ask: did anyone actually reply? ---
  const outboundNow = await directus.countOutboundMessages(convo.id);
  const held = job.stage === 'escalate' ? ROUTING_FIRST_WAIT_MS : ROUTING_SECOND_WAIT_MS;
  const offeredTo = job.attemptedAgentIds[job.attemptedAgentIds.length - 1];

  if (outboundNow > job.outboundCountAtSchedule) {
    if (offeredTo) {
      await directus.recordOutcome({
        conversationId: convo.id,
        agentId: offeredTo,
        outcome: 'answered',
        stage: job.stage,
        secondsHeld: Math.round(held / 1000),
      });
    }
    log('routing: agent replied, escalation cancelled', { id: convo.id });
    return;
  }

  // Reaching here means the timer expired with no reply — a miss for whoever
  // was holding it.
  if (offeredTo) {
    await directus.recordOutcome({
      conversationId: convo.id,
      agentId: offeredTo,
      outcome: 'missed',
      stage: job.stage,
      secondsHeld: Math.round(held / 1000),
    });
  }

  // A human reassigned it to someone outside our ladder — respect that and stop.
  if (convo.assigned_agent && convo.assigned_agent !== offeredTo) {
    log('routing: reassigned by a human, standing down', { id: convo.id });
    return;
  }

  if (job.stage === 'escalate') {
    const agent = await nextAgent(redis, job.attemptedAgentIds, eligible);
    if (!agent) {
      // Everyone eligible has already been offered it. Waiting out a second
      // timer cannot change that, and there is nobody new to hand it to — so
      // it stays where it is, owned, and the ladder stops.
      log('routing: everyone tried, leaving it with the current owner', { id: convo.id });
      return;
    }
    await directus.assign(convo.id, agent);
    await schedule(
      {
        conversationId: convo.id,
        stage: 'broadcast',
        attemptedAgentIds: [...job.attemptedAgentIds, agent],
        outboundCountAtSchedule: outboundNow,
      },
      ROUTING_SECOND_WAIT_MS,
    );
    log('routing: escalated', { id: convo.id, agent });
    return;
  }

  // stage === 'broadcast' — the last rung. It used to release the chat to the
  // pool by nulling the assignee, which is the diffusion-of-responsibility
  // failure this whole ladder exists to prevent. Hand it on instead; if there
  // is nobody left to hand it to, it stays with whoever holds it.
  const agent = await nextAgent(redis, job.attemptedAgentIds, eligible);
  if (!agent) {
    log('routing: nobody left to try, leaving it with the current owner', { id: convo.id });
    return;
  }
  await directus.assign(convo.id, agent);
  log('routing: handed on at the end of the ladder', { id: convo.id, agent });
}
