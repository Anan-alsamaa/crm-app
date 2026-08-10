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
 *   broadcast  no reply in a further 30s → release to the whole pool
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
      status: string;
    } | null>;
    countOutboundMessages(conversationId: string): Promise<number>;
    assign(conversationId: string, agentId: string | null): Promise<void>;
  };
  /** Enqueue the next stage after `delayMs`. */
  schedule(job: RoutingJob, delayMs: number): Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Online agents, idlest first, minus anyone already tried. */
async function nextAgent(redis: Redis | Cluster, attempted: string[]): Promise<string | null> {
  await redis.zremrangebyscore(PRESENCE_KEY, '-inf', Date.now() - PRESENCE_TTL_MS);
  const online = await redis.zrange(PRESENCE_KEY, 0, -1);
  const skip = new Set(attempted);
  return online.find((id) => !skip.has(id)) ?? null;
}

export async function handleRouting(job: RoutingJob, deps: RoutingDeps): Promise<void> {
  const { redis, directus, schedule, log } = deps;
  const convo = await directus.getConversation(job.conversationId);

  // Gone, or already wrapped up — nothing to route.
  if (!convo || convo.status === 'closed' || convo.status === 'resolved') {
    log('routing: conversation not routable', { id: job.conversationId });
    return;
  }

  if (job.stage === 'assign') {
    // Someone already owns it (manual assignment, or a human grabbed it first).
    if (convo.assigned_agent) {
      log('routing: already assigned, standing down', { id: convo.id });
      return;
    }
    const agent = await nextAgent(redis, job.attemptedAgentIds);
    if (!agent) {
      // Nobody online. Leaving it unassigned is correct: it stays visible to
      // everyone, which is better than assigning to an offline agent where it
      // would sit unseen until they happen to log in.
      log('routing: no agents online, leaving open to all', { id: convo.id });
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
  if (outboundNow > job.outboundCountAtSchedule) {
    log('routing: agent replied, escalation cancelled', { id: convo.id });
    return;
  }

  // A human reassigned it to someone outside our ladder — respect that and stop.
  const last = job.attemptedAgentIds[job.attemptedAgentIds.length - 1];
  if (convo.assigned_agent && convo.assigned_agent !== last) {
    log('routing: reassigned by a human, standing down', { id: convo.id });
    return;
  }

  if (job.stage === 'escalate') {
    const agent = await nextAgent(redis, job.attemptedAgentIds);
    if (!agent) {
      // No one else to try — go straight to the pool rather than waiting out a
      // second timer that cannot change the outcome.
      await directus.assign(convo.id, null);
      log('routing: no other agent, released to all', { id: convo.id });
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

  // stage === 'broadcast'
  await directus.assign(convo.id, null);
  log('routing: released to all agents', { id: convo.id });
}
