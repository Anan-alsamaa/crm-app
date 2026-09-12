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
import {
  ROUTING_FIRST_WAIT_MS,
  ROUTING_SECOND_WAIT_MS,
  ROUTING_RECLAIM_WAIT_MS,
  normaliseConversationStatus,
  type RoutingJob,
} from '@yiji/shared-types';

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
    /**
     * Set the owner. `null` RELEASES the conversation to the unassigned pool,
     * which is where a reclaim puts a chat when nobody can take it — an
     * offline owner hides it, no owner makes it visible to everyone.
     */
    assign(conversationId: string, agentId: string | null): Promise<void>;
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
/**
 * Is this agent present right now?
 *
 * The reclaim timer runs 90 s after a socket dropped, and in that time the
 * agent may have signed back in. Asking again at run time is what makes the
 * delay a grace period rather than a countdown to losing your conversation.
 *
 * DELIBERATELY DOES NOT SWEEP THE TTL, and that is the whole point of this
 * function existing separately from the membership test inside `nextAgent`.
 *
 * The set's score is the agent's last ACTIVITY, refreshed only when they send
 * a message — so the TTL sweep that `nextAgent` performs evicts an agent who
 * is signed in and reading but has not typed for 90 seconds. Sweeping here
 * would therefore take a live conversation away from an agent sitting at their
 * desk, which is exactly the behaviour the owner ruled out (2026-09-10): a
 * chat moves only if the agent LOGGED OUT and did not come back, never because
 * they were quiet.
 *
 * Membership alone answers that. `online()` adds on connect and `offline()`
 * removes on disconnect and on sign-out, so presence in the set means "holds a
 * session", independent of how long ago they last typed.
 */
async function isSignedIn(redis: Redis | Cluster, agentId: string): Promise<boolean> {
  return (await redis.zscore(PRESENCE_KEY, agentId)) !== null;
}

async function nextAgent(
  redis: Redis | Cluster,
  attempted: string[],
  eligible: string[],
): Promise<string | null> {
  const skip = new Set(attempted);
  /**
   * An EMPTY eligible list means nobody is eligible — not everybody.
   *
   * This used to fall back to `null` ("no restriction"), so a deployment with
   * no Agent-role users would hand the chat to whoever happened to be online:
   * an Administrator, or any account holding a socket. That is the same failure
   * as routing to a service account, reached by a different door. With nobody
   * eligible the honest outcome is nobody — the caller then leaves the chat in
   * the unassigned pool, where every agent can see and rescue it, and logs that
   * the roster is misconfigured.
   */
  const allowed = new Set(eligible);

  await redis.zremrangebyscore(PRESENCE_KEY, '-inf', Date.now() - PRESENCE_TTL_MS);
  const online = await redis.zrange(PRESENCE_KEY, 0, -1);
  const onlineHit = online.find((id) => !skip.has(id) && allowed.has(id));
  if (onlineHit) return onlineHit;

  // Nobody online (or nobody online on this team). `eligible` is already
  // ordered least-loaded first.
  return eligible.find((id) => !skip.has(id)) ?? null;
}

export async function handleRouting(job: RoutingJob, deps: RoutingDeps): Promise<void> {
  const { redis, directus, schedule, log } = deps;
  const convo = await directus.getConversation(job.conversationId);

  /*
   * Gone, or already wrapped up — nothing to route.
   *
   * Compared through `normaliseConversationStatus` rather than against literals.
   * The live vocabulary is `open` / `solved`; `closed` and `resolved` are
   * RETIRED names that this guard was still checking for, so a conversation
   * marked `solved` read as routable and could be assigned to somebody after it
   * had been finished. Found by a reclaim test asserting a solved chat is left
   * alone. Historical rows still carry the retired values, which is exactly
   * what the normaliser is for.
   */
  if (!convo || normaliseConversationStatus(convo.status) === 'solved') {
    log('routing: conversation not routable', { id: job.conversationId });
    return;
  }

  // The pool this chat may be offered to: its team's roster, or everyone.
  const eligible = await directus.agentsByLoad(convo.assigned_team);

  /*
   * RECLAIM — the owner's connection dropped mid-conversation.
   *
   * Everything below assumes "nobody has answered yet"; this stage is the one
   * case where a chat that IS owned must move. It is scheduled by the gateway
   * when an agent's socket goes away, and it deliberately runs late
   * (ROUTING_RECLAIM_WAIT_MS) so an agent who reloads or crosses a network
   * boundary keeps their chat.
   *
   * It re-checks EVERYTHING at run time rather than trusting the schedule:
   * ownership may have changed, and the agent may simply be back.
   */
  if (job.stage === 'reclaim') {
    const previous = job.previousAgentId;
    if (!previous) {
      log('routing: reclaim without a previous owner, ignoring', { id: convo.id });
      return;
    }
    /* Somebody else already owns it — a human moved it, or the agent came back
       and handed it on. Their decision outranks this timer. */
    if (convo.assigned_agent !== previous) {
      log('routing: reclaim superseded, standing down', { id: convo.id });
      return;
    }
    /* THEY CAME BACK. The whole point of the delay: a reload or a network
       change must not cost an agent their conversation. */
    if (await isSignedIn(redis, previous)) {
      log('routing: previous owner is signed back in, keeping the chat', {
        id: convo.id,
        agent: previous,
      });
      return;
    }
    // Never hand it back to the agent who just vanished.
    const agent = await nextAgent(redis, [previous, ...job.attemptedAgentIds], eligible);
    if (!agent) {
      /* Nobody to take it. Leaving it with an offline agent would hide it, so
         it goes to the unassigned pool where every agent can see and rescue
         it — the same choice `assign` makes when the roster is empty. */
      await directus.assign(convo.id, null);
      await directus.recordOutcome({
        conversationId: convo.id,
        agentId: previous,
        outcome: 'missed',
        stage: 'reclaim',
        secondsHeld: Math.round(ROUTING_RECLAIM_WAIT_MS / 1000),
      });
      log('routing: owner offline and nobody to take it — released to the pool', {
        id: convo.id,
        previous,
      });
      return;
    }
    await directus.assign(convo.id, agent);
    /* Measured, per the owner's request: every handover leaves a row saying
       whose chat moved, to whom, and why. `routing_events` is what the reports
       already read. */
    await directus.recordOutcome({
      conversationId: convo.id,
      agentId: previous,
      outcome: 'missed',
      stage: 'reclaim',
      secondsHeld: Math.round(ROUTING_RECLAIM_WAIT_MS / 1000),
    });
    log('routing: reclaimed from an offline agent', { id: convo.id, from: previous, to: agent });
    return;
  }

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
      /*
       * Nobody new to hand it to, so it stays where it is and the ladder stops.
       *
       * SAY WHICH OF THE TWO THIS IS. The message used to be "everyone tried",
       * which reads identically whether the roster holds twenty agents or one —
       * and when production briefly had a single routable agent, that line was
       * the only evidence, so a correct ladder looked like a broken one to the
       * team testing it (reported 2026-09-10).
       *
       * A roster at or below the number already attempted is a CONFIGURATION
       * problem: no amount of waiting produces another agent. Logged as a
       * warning with the counts, so it is visible without reading the code.
       */
      /*
       * Fewer than two eligible agents is a CONFIGURATION problem: the ladder
       * cannot escalate to anybody, ever, no matter how long it waits.
       *
       * Deliberately NOT `eligible.length <= attempted.length` — with three
       * agents all legitimately tried that comparison is also true, and would
       * mislabel healthy exhaustion as a misconfigured roster. Caught by the
       * test below, which is exactly why it is there.
       */
      const exhausted = eligible.length < 2;
      log(
        exhausted
          ? 'routing: ROSTER TOO SMALL to escalate — add more agents in a routable role'
          : 'routing: everyone available has been tried, leaving it with the current owner',
        {
          id: convo.id,
          eligibleAgents: eligible.length,
          alreadyOffered: job.attemptedAgentIds.length,
          team: convo.assigned_team,
        },
      );
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

  /*
   * stage === 'broadcast' — THE LAST RUNG RELEASES IT TO EVERYONE.
   *
   * The rule (owner, 2026-09-12): first agent has 60s, the next-most-free has
   * 30s, and after that the chat is shown to EVERY logged-in agent so whoever
   * is free can take it.
   *
   * This previously handed it to a third named agent instead. That was a
   * deliberate change — the concern was diffusion of responsibility, a chat
   * nobody owns being a chat nobody answers — but it is not the behaviour the
   * owner specified, and it had a worse failure of its own: with four agents
   * the ladder silently never reached the fourth, and a customer waited on one
   * person who had already ignored them twice.
   *
   * Unassigned is VISIBLE, not hidden: the inbox query admits
   * `assigned_agent _null` for every agent, so the pool is the one state the
   * whole team can see and act on.
   */
  await directus.assign(convo.id, null);
  /* The miss against whoever was holding it is ALREADY recorded above, for
     both stages — recording it again here would double-count the same agent
     in the routing report. */
  log('routing: released to every agent — whoever is free can take it', {
    id: convo.id,
    eligibleAgents: eligible.length,
  });
}
