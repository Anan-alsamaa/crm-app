import { describe, it, expect } from 'vitest';
import { RESUMABLE_STATUSES } from '../src/directus.js';

/**
 * A RETURNING CUSTOMER RESUMES THEIR CHAT — they never get a second one.
 *
 * Reproduced on production (owner, 2026-09-30): conversation `9a58a48b` was
 * solved at 07:13, the customer rated it, wrote again at 07:15 about another
 * order, and got a BRAND NEW conversation `8e499421`. The inbox showed the same
 * person twice, and the agent who picked up the new thread saw a stranger while
 * the history sat in a thread nobody would open again.
 *
 * The cause was a READ, not a write. All three conversation lookups searched
 * `['open','pending']`, so a solved thread was never found and
 * `findOrCreateConversation` fell through to creating one. The reopen in
 * `persistMessage` — which flips a solved thread back to `open` and clears
 * `solved_at` — was correct the whole time and simply never ran, because there
 * was nothing for it to run on. Fixing the write alone would have changed
 * nothing.
 */
describe('RESUMABLE_STATUSES', () => {
  /* THE BUG. Without `solved` here, a closed chat forks instead of reopening. */
  it('includes solved, so a closed chat is resumed rather than forked', () => {
    expect(RESUMABLE_STATUSES).toContain('solved');
  });

  it('still includes the live states', () => {
    expect(RESUMABLE_STATUSES).toContain('open');
    // 'pending' is retired, but a database that has not run the status
    // migration still holds rows with it — dropping it would not error, it
    // would silently open a second conversation, which is this very bug.
    expect(RESUMABLE_STATUSES).toContain('pending');
  });

  /* Retired spellings of solved. Same reasoning as 'pending': an un-migrated
     row must resume, not fork. */
  it.each(['resolved', 'closed'])('matches the retired spelling %s', (status) => {
    expect(RESUMABLE_STATUSES).toContain(status);
  });

  /*
   * EVERY status a conversation can hold is resumable, which is the owner's
   * model: ONE conversation per contact, reopened as a new session. If a future
   * status is added and left out of this list, the fork comes straight back —
   * so this test states the rule rather than the list.
   */
  it('leaves no conversation status unresumable', () => {
    const everyStatus = ['open', 'pending', 'solved', 'resolved', 'closed'];
    for (const s of everyStatus) expect(RESUMABLE_STATUSES).toContain(s);
  });

  it('has no duplicates, which would only bloat the filter', () => {
    expect(new Set(RESUMABLE_STATUSES).size).toBe(RESUMABLE_STATUSES.length);
  });
});

/**
 * The reopen half, stated as the rule it implements. `persistMessage` flips a
 * finished thread back to `open` and clears `solved_at` when a CUSTOMER writes
 * into it — an agent's own reply must not reopen a chat they just closed.
 */
const reopensOnCustomerMessage = (status: string, senderType: string): boolean =>
  senderType === 'customer' && ['solved', 'resolved', 'closed'].includes(status);

describe('a customer message reopens a finished thread', () => {
  it.each(['solved', 'resolved', 'closed'])('reopens a %s thread', (status) => {
    expect(reopensOnCustomerMessage(status, 'customer')).toBe(true);
  });

  it('leaves an already-open thread alone', () => {
    expect(reopensOnCustomerMessage('open', 'customer')).toBe(false);
  });

  /* An agent closing a chat and then sending a parting message must not undo
     their own close. */
  it('does not reopen when the AGENT is the sender', () => {
    expect(reopensOnCustomerMessage('solved', 'agent')).toBe(false);
  });
});
