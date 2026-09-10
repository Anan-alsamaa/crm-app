import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { reclaimConversationsOf } from '../src/connection.js';

/**
 * An agent's live chats when their connection drops.
 *
 * REPORTED BY THE OWNER (2026-09-10): an agent goes offline partway through a
 * conversation and it stays theirs. Nothing rescued it — the routing ladder
 * stands down the moment it sees an owner, so the chat sat with a ghost until
 * a human noticed.
 *
 * This is only the SCHEDULING half: it decides nothing about who gets the chat.
 * The `reclaim` job re-checks ownership and presence when it runs 90 seconds
 * later, so an agent who reloads keeps everything. See routing.test.ts for the
 * decision itself.
 */
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function deps(ids: string[]) {
  const enqueueRouting = vi.fn().mockResolvedValue('job-1');
  return {
    enqueueRouting,
    d: {
      directus: {
        listAgentOwnedOpenConversationIds: vi.fn().mockResolvedValue(ids),
      },
      producer: { enqueueRouting },
      logger,
    } as never,
  };
}

describe('scheduling a reclaim when an agent disconnects', () => {
  it('queues one reclaim per open conversation they own', async () => {
    const t = deps(['c1', 'c2']);
    const n = await reclaimConversationsOf('gone', t.d);
    expect(n).toBe(2);
    expect(t.enqueueRouting).toHaveBeenCalledTimes(2);
  });

  it('names the departing agent, so the job can refuse to hand it back', async () => {
    const t = deps(['c1']);
    await reclaimConversationsOf('gone', t.d);
    expect(t.enqueueRouting).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        stage: 'reclaim',
        previousAgentId: 'gone',
      }),
    );
  });

  it('does nothing at all for an agent holding no chats', async () => {
    // The common case by far — most disconnects are of agents with nothing
    // assigned, and they must not cost a queue write.
    const t = deps([]);
    expect(await reclaimConversationsOf('idle', t.d)).toBe(0);
    expect(t.enqueueRouting).not.toHaveBeenCalled();
  });
});
