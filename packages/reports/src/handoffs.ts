/**
 * Which chats were passed on, and who ended up taking them.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The auto-assignment ladder gives a new chat to one agent, and if they have
 * not replied it hands it to another, and then to a third. First response is
 * measured from the CUSTOMER's first message — which is correct, it is the only
 * thing the customer experiences — but it means the third agent inherits the
 * ninety seconds the first two spent not answering. Holding them to the same
 * target as somebody who got a chat cleanly is measuring the ladder, not the
 * agent, and an unfair number is one people learn to ignore.
 *
 * So a chat that was passed on leaves the personal first-response population
 * entirely and is counted somewhere else: COMMON CHATS. Whoever picks one up is
 * credited with having picked up work nobody else answered — which is the thing
 * actually worth competing over, and it is invisible in a plain response-time
 * average.
 *
 * The counts are honest in both directions. Missing a chat you were offered
 * still lands on you (`missedOffers`); taking one somebody else missed still
 * counts for you. Neither is inferred from the conversation row, which only
 * remembers its CURRENT owner — the history lives in `routing_events`, which is
 * append-only precisely so "who was asked, and did they answer" survives the
 * next reassignment.
 */

/** One `routing_events` row: an offer, and what became of it. */
export interface RoutingEvent {
  conversation: string;
  /** Directus user id. Null when the account has since been deleted. */
  agent: string | null;
  outcome: 'answered' | 'missed' | string;
  /** 'assign' is the first offer; anything else means it had been passed on. */
  stage: 'assign' | 'escalate' | 'broadcast' | string;
}

export interface ChatHandoff {
  /**
   * True when this chat was offered to somebody beyond the first agent.
   *
   * Judged on the STAGE of the offers, not on how many agents appear: a chat
   * re-offered to the same person is still a chat that was not answered first
   * time.
   */
  passedOn: boolean;
  /**
   * The agent who answered it after it had been passed on — the one who gets
   * the "common chat" credit. Null when nobody did (it may still be waiting).
   */
  takenBy: string | null;
}

const PASSED_ON_STAGES = new Set(['escalate', 'broadcast']);

/**
 * Reduce raw routing events to one verdict per conversation.
 *
 * Callers hand in every event for the conversations they are reporting on; the
 * order does not matter.
 */
export function chatHandoffs(events: readonly RoutingEvent[]): Map<string, ChatHandoff> {
  const out = new Map<string, ChatHandoff>();
  for (const e of events) {
    const at = out.get(e.conversation) ?? { passedOn: false, takenBy: null };
    if (PASSED_ON_STAGES.has(e.stage)) {
      at.passedOn = true;
      // Answered at a late stage = somebody picked up a chat that had already
      // gone unanswered. That is the whole definition of a common chat.
      if (e.outcome === 'answered' && e.agent) at.takenBy = e.agent;
    }
    out.set(e.conversation, at);
  }
  return out;
}

/**
 * How many chats each agent was offered and did not answer in time.
 *
 * Reported beside the common-chat count so the pair reads as one story: work
 * you let go, and work you picked up. Showing only the flattering half would
 * make the leaderboard a reason to distrust the page.
 */
export function missedOffers(events: readonly RoutingEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.outcome !== 'missed' || !e.agent) continue;
    out.set(e.agent, (out.get(e.agent) ?? 0) + 1);
  }
  return out;
}
