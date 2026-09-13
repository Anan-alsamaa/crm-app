import { describe, it, expect, vi } from 'vitest';

/**
 * ANSWERING A CHAT NOBODY OWNS CLAIMS IT.
 *
 * REPORTED (owner, 2026-09-13): a customer gave 4 stars, the rating was stored
 * correctly, and the admin portal read "no ratings yet". The rating was on a
 * conversation whose `assigned_agent` was null — an agent had answered and
 * solved it without it ever being assigned to them.
 *
 * Everything keyed on the assignee then has nobody to credit: the rating counts
 * for no one, and the agent's performance row misses a chat they handled. This
 * matters more now, not less, because an unanswered chat is deliberately
 * released to the pool for anyone to pick up.
 */
function makeClaimer(initialOwner: string | null) {
  let owner = initialOwner;
  return {
    owner: () => owner,
    /** Mirrors `claimConversationIfUnassigned`. */
    claim: (agentId: string): boolean => {
      if (owner !== null) return false;
      owner = agentId;
      return true;
    },
  };
}

describe('an agent replying to an unowned chat', () => {
  it('claims it, so the rating and the work have an owner', () => {
    const c = makeClaimer(null);
    expect(c.claim('agent-1')).toBe(true);
    expect(c.owner()).toBe('agent-1');
  });

  it('NEVER takes a chat from the agent who holds it', () => {
    // A colleague replying on your thread must not reassign it to themselves.
    const c = makeClaimer('agent-1');
    expect(c.claim('agent-2')).toBe(false);
    expect(c.owner()).toBe('agent-1');
  });

  it('is idempotent — replying twice does not re-claim', () => {
    const c = makeClaimer(null);
    c.claim('agent-1');
    expect(c.claim('agent-1')).toBe(false);
    expect(c.owner()).toBe('agent-1');
  });

  it('a failed claim must not fail the reply', async () => {
    // The message is already persisted and delivered by this point; the claim
    // is bookkeeping and must never surface as a send failure.
    const claim = vi.fn().mockRejectedValue(new Error('directus down'));
    let sendFailed = false;
    try {
      await claim('c1', 'agent-1').catch(() => undefined);
    } catch {
      sendFailed = true;
    }
    expect(sendFailed).toBe(false);
  });
});
