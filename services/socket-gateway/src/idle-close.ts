import type { Redis, Cluster } from 'ioredis';
import {
  chatIdleMinutes,
  CHAT_IDLE_MINUTES_KEY,
  detectLocale,
  idleCloseMessage,
  shouldCloseForIdle,
} from '@yiji/shared-types';

/**
 * Close chats the customer has gone quiet on, and say goodbye kindly.
 *
 * The owner's rule (2026-09-30): five configurable minutes of idleness where the
 * last message was the AGENT'S — the customer has not texted and has not
 * attached anything. A chat whose last message is the customer's is never closed
 * here; that one is waiting on us.
 *
 * WHY THE GATEWAY, not the workers. Two reasons, and both are load-bearing:
 * only the gateway can write a message AND broadcast it to a widget that is
 * still open, and only the gateway holds the socket rooms the customer is
 * listening on. A worker could write the row and the customer would sit looking
 * at a chat that had silently ended.
 */

export interface IdleCloseDeps {
  directus: {
    /** Conversations that might be idle, newest activity first. */
    findIdleCandidates(
      sinceIso: string,
    ): Promise<Array<{ id: string; status: string | null; last_message_at: string | null }>>;
    /** Who sent the most recent message in this conversation. */
    lastSenderType(conversationId: string): Promise<'customer' | 'agent' | 'system' | null>;
    /** Read one `app_settings` value. */
    readSetting(key: string): Promise<string | null>;
    /** The customer's own messages — what their language is read from. */
    recentCustomerTexts(conversationId: string, limit?: number): Promise<string[]>;
    persistMessage(input: {
      conversationId: string;
      senderType: 'system';
      content: string;
    }): Promise<{ id: string; createdAt: string }>;
    closeConversation(conversationId: string, atIso: string): Promise<void>;
  };
  /** Tell everyone watching this chat, so a live widget updates itself. */
  broadcast(
    conversationId: string,
    message: { id: string; content: string; createdAt: string },
  ): void;
  logger: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** Injectable for the tests. */
  now?: () => number;
}

/**
 * One pass. Returns how many chats it closed, which is what the caller logs.
 *
 * Deliberately sequential and small: it asks only for conversations whose last
 * activity is old enough to POSSIBLY qualify, so the candidate set is a handful
 * even on a busy day, and each one then costs one cheap query for its last
 * sender. A join would be faster and would also mean this rule lived in SQL,
 * where `shouldCloseForIdle` could not be tested.
 */
export async function runIdleCloseSweep(deps: IdleCloseDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const minutes = chatIdleMinutes(await deps.directus.readSetting(CHAT_IDLE_MINUTES_KEY));
  /* Ask only for what could qualify. The cutoff IS the threshold, so a chat
     that became idle one second ago is simply not in the answer yet. */
  const sinceIso = new Date(now - minutes * 60_000).toISOString();

  let candidates: Awaited<ReturnType<IdleCloseDeps['directus']['findIdleCandidates']>>;
  try {
    candidates = await deps.directus.findIdleCandidates(sinceIso);
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message }, 'idle-close: could not read candidates');
    return 0;
  }

  let closed = 0;
  for (const c of candidates) {
    try {
      const lastSenderType = await deps.directus.lastSenderType(c.id);
      if (
        !shouldCloseForIdle(
          { status: c.status, lastSenderType, lastMessageAt: c.last_message_at },
          minutes,
          now,
        )
      ) {
        continue;
      }

      /* Their language, from their own words — there is no locale column, and
         this is better evidence than one anyway. */
      const content = idleCloseMessage(detectLocale(await deps.directus.recentCustomerTexts(c.id)));
      /*
       * THE MESSAGE FIRST, then the status.
       *
       * If the close failed after the message we would have said goodbye on a
       * chat still sitting open — odd, but harmless and self-correcting on the
       * next sweep. The other order risks closing a chat and never telling the
       * customer why it ended, which is the outcome this whole feature exists to
       * avoid.
       */
      const saved = await deps.directus.persistMessage({
        conversationId: c.id,
        senderType: 'system',
        content,
      });
      await deps.directus.closeConversation(c.id, new Date(now).toISOString());
      // So a widget that is still open shows the goodbye rather than going mute.
      deps.broadcast(c.id, { id: saved.id, content, createdAt: saved.createdAt });
      closed += 1;
    } catch (err) {
      /* One unclosable chat must not stop the rest. It stays open and the next
         sweep tries again, which is the right failure: nothing is lost. */
      deps.logger.warn(
        { err: (err as Error).message, conversationId: c.id },
        'idle-close: could not close one conversation',
      );
    }
  }

  if (closed > 0) deps.logger.info({ closed, minutes }, 'idle-close: closed quiet chats');
  return closed;
}

/**
 * ONLY ONE TASK MAY SWEEP.
 *
 * socket-gateway runs 2 tasks in production. Without this both would find the
 * same idle chats in the same second and each would write a goodbye — the
 * customer gets the message twice, which reads worse than not closing at all.
 *
 * A short Redis lock rather than a leader election: the sweep is idempotent in
 * effect (a closed chat no longer qualifies), so all this has to do is stop the
 * overlap. The TTL is deliberately just over the interval, so a task that dies
 * mid-sweep cannot hold the lock for long.
 *
 * NO REDIS, NO LOCK — a single-task environment (staging, local) sweeps anyway
 * rather than not at all.
 */
export async function withSweepLock(
  redis: Redis | Cluster | undefined,
  ttlMs: number,
  run: () => Promise<void>,
): Promise<void> {
  if (!redis) return run();
  try {
    const ok = await redis.set('crm:idle-close:lock', String(Date.now()), 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return;
  } catch {
    /* Redis unreachable. Sweeping is better than silently stopping: the worst
       case is a duplicate goodbye, the alternative is chats never closing. */
  }
  await run();
}
