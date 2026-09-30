import { describe, it, expect, vi } from 'vitest';
import { runIdleCloseSweep, withSweepLock } from '../src/idle-close.js';
import { IDLE_CLOSE_MESSAGE } from '@yiji/shared-types';

/**
 * THE SWEEP THAT CLOSES QUIET CHATS (owner, 2026-09-30).
 *
 * Five configurable minutes of idleness where the last message was the AGENT'S.
 * This is customer-facing and one-way from their side — they receive a goodbye —
 * so the tests below are mostly about what it must NOT close, and about the
 * order of the two writes.
 */
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

function makeDeps(
  candidates: Array<{ id: string; status: string | null; last_message_at: string | null }>,
  opts: {
    lastSender?: 'customer' | 'agent' | 'system' | null;
    setting?: string | null;
    texts?: string[];
    failClose?: boolean;
  } = {},
) {
  const persisted: Array<{ conversationId: string; content: string }> = [];
  const closedIds: string[] = [];
  const broadcasts: Array<{ conversationId: string; content: string }> = [];
  const deps = {
    directus: {
      findIdleCandidates: vi.fn().mockResolvedValue(candidates),
      lastSenderType: vi.fn().mockResolvedValue(opts.lastSender ?? 'agent'),
      readSetting: vi.fn().mockResolvedValue(opts.setting ?? null),
      recentCustomerTexts: vi.fn().mockResolvedValue(opts.texts ?? []),
      persistMessage: vi.fn(async (input: { conversationId: string; content: string }) => {
        persisted.push(input);
        return { id: `msg-${persisted.length}`, createdAt: new Date(NOW).toISOString() };
      }),
      closeConversation: vi.fn(async (id: string) => {
        if (opts.failClose) throw new Error('directus down');
        closedIds.push(id);
      }),
    },
    broadcast: vi.fn((conversationId: string, m: { content: string }) =>
      broadcasts.push({ conversationId, content: m.content }),
    ),
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW,
  };
  return { deps, persisted, closedIds, broadcasts };
}

describe('runIdleCloseSweep', () => {
  it('closes an idle chat, sends the goodbye, and tells the open widget', async () => {
    const { deps, persisted, closedIds, broadcasts } = makeDeps([
      { id: 'c1', status: 'open', last_message_at: ago(9) },
    ]);

    expect(await runIdleCloseSweep(deps)).toBe(1);
    /* `system`, not `agent`: the customer must not see this as somebody typing
       to them, and agent-performance measures must not count it as a reply. */
    expect(persisted).toEqual([
      { conversationId: 'c1', senderType: 'system', content: IDLE_CLOSE_MESSAGE.ar },
    ]);
    expect(closedIds).toEqual(['c1']);
    // The broadcast is what stops a live widget going mute instead of showing
    // why the chat ended.
    expect(broadcasts).toEqual([{ conversationId: 'c1', content: IDLE_CLOSE_MESSAGE.ar }]);
  });

  /*
   * THE MESSAGE BEFORE THE CLOSE, deliberately. A goodbye on a chat still open
   * is odd but harmless and self-corrects next sweep; a close with no goodbye
   * leaves the customer never told why it ended, which is the outcome this
   * feature exists to prevent.
   */
  it('writes the goodbye before closing', async () => {
    const order: string[] = [];
    const { deps } = makeDeps([{ id: 'c1', status: 'open', last_message_at: ago(9) }]);
    deps.directus.persistMessage.mockImplementation(async () => {
      order.push('message');
      return { id: 'm1', createdAt: new Date(NOW).toISOString() };
    });
    deps.directus.closeConversation.mockImplementation(async () => {
      order.push('close');
    });

    await runIdleCloseSweep(deps);
    expect(order).toEqual(['message', 'close']);
  });

  /* THE MOST IMPORTANT ONE: a customer's message means the ball is with US. */
  it('does not close a chat the customer spoke in last', async () => {
    const { deps, persisted, closedIds } = makeDeps(
      [{ id: 'c1', status: 'open', last_message_at: ago(90) }],
      { lastSender: 'customer' },
    );
    expect(await runIdleCloseSweep(deps)).toBe(0);
    expect(persisted).toEqual([]);
    expect(closedIds).toEqual([]);
  });

  it('honours the configured threshold', async () => {
    // 30-minute setting: a chat idle 9 minutes is not yet due.
    const { deps } = makeDeps([{ id: 'c1', status: 'open', last_message_at: ago(9) }], {
      setting: '30',
    });
    expect(await runIdleCloseSweep(deps)).toBe(0);
  });

  it('sends English when the customer wrote in English', async () => {
    const { deps, persisted } = makeDeps([{ id: 'c1', status: 'open', last_message_at: ago(9) }], {
      texts: ['where is my order?'],
    });
    await runIdleCloseSweep(deps);
    expect(persisted[0]?.content).toBe(IDLE_CLOSE_MESSAGE.en);
  });

  /* ONE BAD CHAT MUST NOT STOP THE REST. It stays open and the next sweep
     retries, which is the right failure: nothing is lost. */
  it('keeps going when one conversation cannot be closed', async () => {
    const { deps } = makeDeps(
      [
        { id: 'c1', status: 'open', last_message_at: ago(9) },
        { id: 'c2', status: 'open', last_message_at: ago(9) },
      ],
      { failClose: true },
    );
    expect(await runIdleCloseSweep(deps)).toBe(0);
    // Both were attempted, and both were logged rather than thrown.
    expect(deps.directus.persistMessage).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledTimes(2);
  });

  /* A failed candidate read is not "nothing is idle" — it closes nothing and
     says so, rather than taking the gateway down. */
  it('closes nothing when the candidate query fails', async () => {
    const { deps } = makeDeps([]);
    deps.directus.findIdleCandidates.mockRejectedValue(new Error('timeout'));
    expect(await runIdleCloseSweep(deps)).toBe(0);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('asks only for chats already past the threshold', async () => {
    const { deps } = makeDeps([], { setting: '5' });
    await runIdleCloseSweep(deps);
    expect(deps.directus.findIdleCandidates).toHaveBeenCalledWith(
      new Date(NOW - 5 * 60_000).toISOString(),
    );
  });
});

/**
 * ONLY ONE TASK MAY SWEEP. socket-gateway runs 2 tasks in production; without
 * the lock both find the same chats in the same second and the customer gets the
 * goodbye twice, which reads worse than not closing at all.
 */
describe('withSweepLock', () => {
  it('runs when it takes the lock', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    await withSweepLock(redis as never, 1000, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('SKIPS when another task already holds it', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const redis = { set: vi.fn().mockResolvedValue(null) };
    await withSweepLock(redis as never, 1000, run);
    expect(run).not.toHaveBeenCalled();
  });

  /* No Redis at all — staging, local. Sweeping is right: there is only one task,
     so there is nothing to collide with. */
  it('runs without Redis rather than not at all', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await withSweepLock(undefined, 1000, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /* Redis unreachable. A duplicate goodbye is a worse-case; chats never closing
     is a certainty. Prefer the sweep. */
  it('runs when Redis throws', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const redis = { set: vi.fn().mockRejectedValue(new Error('down')) };
    await withSweepLock(redis as never, 1000, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('sets the lock with NX and a TTL, so a dead task cannot hold it', async () => {
    const redis = { set: vi.fn().mockResolvedValue('OK') };
    await withSweepLock(redis as never, 65_000, async () => {});
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'PX',
      65_000,
      'NX',
    );
  });
});
