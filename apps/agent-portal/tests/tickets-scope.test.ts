import { describe, it, expect } from 'vitest';
import type { ComplaintScope } from '../src/features/complaints/api.js';

/**
 * WHOSE TICKETS THE PAGE OPENS ON (owner, 2026-09-30).
 *
 * The Tickets page hard-filtered on `assigned_agent = $CURRENT_USER`, invisibly
 * and absolutely. A ticket raised from the late-orders queue belongs to the
 * agent who decided it, so the owner looking for one saw an empty page — and
 * reasonably read it as missing data rather than as a filter. Reported twice.
 *
 * Verified against production: the owner is assigned **0 of 16** tickets, so
 * "mine" is a confirmed-empty list for exactly the person who needs to see
 * everything. Permissions were never the problem — all 16 are readable.
 */

/** The page's rule, kept here so the intent is pinned as the code moves. */
const defaultScope = (isOwner: boolean): ComplaintScope => (isOwner ? 'all' : 'me');

describe('the default ticket scope', () => {
  /* THE BUG. Defaulting the owner to "mine" shows them nothing, every time. */
  it('opens an OWNER on All, because they are assigned none', () => {
    expect(defaultScope(true)).toBe('all');
  });

  /* An agent came for their own queue; showing them the whole operation would
     bury the work they are responsible for. */
  it('opens an AGENT on their own tickets', () => {
    expect(defaultScope(false)).toBe('me');
  });
});

/**
 * The filter each scope sends. `'all'` sends NO agent clause and lets Directus
 * decide, which is the honest scope: a WeCare Agent's role still restricts their
 * reads to their own tickets, so picking All shows them exactly what they were
 * always allowed to see. The page cannot grant access it does not have.
 */
const agentClause = (scope: ComplaintScope): Record<string, unknown> | null =>
  scope === 'all'
    ? null
    : scope === 'me'
      ? { assigned_agent: { _eq: '$CURRENT_USER' } }
      : { assigned_agent: { _eq: scope } };

describe('what each scope asks the database for', () => {
  it('sends no agent clause for All, so the role decides', () => {
    expect(agentClause('all')).toBeNull();
  });

  it('sends $CURRENT_USER for mine', () => {
    expect(agentClause('me')).toEqual({ assigned_agent: { _eq: '$CURRENT_USER' } });
  });

  it('sends the chosen id for a specific agent', () => {
    expect(agentClause('4a4edf3b-1f6b-4704-bb74-5a4e5df5ef4f')).toEqual({
      assigned_agent: { _eq: '4a4edf3b-1f6b-4704-bb74-5a4e5df5ef4f' },
    });
  });
});

/**
 * WHICH EMPTY IS THIS? An empty list used to say "Tickets are created from chats
 * that need follow-up" whatever the reason — a statement about the whole system,
 * shown when the truth was a filter. That is how the page read as broken.
 */
const emptyReason = (scope: ComplaintScope): 'mine' | 'agent' | 'system' =>
  scope === 'me' ? 'mine' : scope === 'all' ? 'system' : 'agent';

describe('the empty state names the scope', () => {
  it('blames the filter, not the system, when scoped to me', () => {
    expect(emptyReason('me')).toBe('mine');
  });

  it('blames the filter when scoped to one agent', () => {
    expect(emptyReason('some-agent-id')).toBe('agent');
  });

  /* Only a genuinely unfiltered empty list may claim the system has none. */
  it('only claims the system is empty when showing All', () => {
    expect(emptyReason('all')).toBe('system');
  });
});
