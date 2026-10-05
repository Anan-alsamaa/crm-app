import { describe, it, expect } from 'vitest';
import { shouldCloseForIdle } from '../src/chat-autoclose.js';

/**
 * A CHAT THE AGENT STARTED IS NOT ABANDONED BY A CUSTOMER WHO HAS NOT LOOKED.
 *
 * Owner, 2026-10-05:
 *
 *   "a edge case found for the chat initiated by agent. in this case, the chat
 *    should not be closed in 5 minutes, as the agent sent a message and the
 *    customer received the notification but did not open the chat. it should be
 *    open. the close applies for an ongoing conversation ignored by the
 *    customer and the customer did not come back for 5 minutes."
 *
 * The sweep's four original conditions were all TRUE of an agent-initiated
 * chat: it is open, its last message is the agent's, it carries a timestamp,
 * and five minutes pass quickly. So the chat was closed while the customer was
 * still looking at the notification — and when they tapped it, they landed in
 * a conversation that had already said goodbye. A business approaching someone
 * and then hanging up before they answer.
 *
 * The distinction the owner draws is exactly right: idleness needs an *ongoing
 * conversation*, which means the customer must have had a turn. Before their
 * first message there is nothing to abandon.
 */

const FIVE_MIN = 5;
const NOW = Date.parse('2026-10-05T12:00:00Z');
/** Comfortably past the threshold, so only the new rule can hold it open. */
const LONG_AGO = '2026-10-05T11:50:00Z';

describe('an agent-initiated chat the customer has not answered', () => {
  it('stays open however long it waits', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'agent',
          lastMessageAt: LONG_AGO,
          initiatedBy: 'agent',
          customerHasReplied: false,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(false);
  });

  /* A day later it is still waiting on the customer, not abandoned by them.
     If this ever needs an upper bound it should be its own deliberate rule
     with its own wording, not this one quietly expiring. */
  it('is still open a day later', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'agent',
          lastMessageAt: '2026-10-04T12:00:00Z',
          initiatedBy: 'agent',
          customerHasReplied: false,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(false);
  });

  it('is held open on `pending` too, not only `open`', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'pending',
          lastSenderType: 'agent',
          lastMessageAt: LONG_AGO,
          initiatedBy: 'agent',
          customerHasReplied: false,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(false);
  });
});

describe('once the customer HAS replied, the ordinary rule resumes', () => {
  /*
   * THE OTHER HALF, and the one that makes this safe. `initiatedBy` alone
   * would keep an agent-started chat open for ever after the customer replied
   * and went quiet — the exact case the sweep exists for. Both conditions are
   * required.
   */
  it('closes an agent-initiated chat the customer joined and then left', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'agent',
          lastMessageAt: LONG_AGO,
          initiatedBy: 'agent',
          customerHasReplied: true,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(true);
  });

  /* And it still honours the clock — one minute of quiet is not five. */
  it('does not close one that went quiet a minute ago', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'agent',
          lastMessageAt: '2026-10-05T11:59:00Z',
          initiatedBy: 'agent',
          customerHasReplied: true,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(false);
  });
});

describe('a customer-initiated chat is completely unaffected', () => {
  /*
   * THE REGRESSION GUARD. This is the overwhelming majority of traffic, and a
   * new condition that quietly caught it too would stop the sweep doing its
   * job — chats piling up open with nobody told why.
   */
  it('still closes when the agent spoke last and the customer went quiet', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'agent',
          lastMessageAt: LONG_AGO,
          initiatedBy: 'customer',
          customerHasReplied: true,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(true);
  });

  /*
   * WITH THE FIELDS ABSENT ENTIRELY — the shape every existing caller had
   * before today, and what a row written before the column existed looks
   * like. It must behave exactly as it always did.
   */
  it('closes when neither new field is supplied at all', () => {
    expect(
      shouldCloseForIdle(
        { status: 'open', lastSenderType: 'agent', lastMessageAt: LONG_AGO },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(true);
  });

  /*
   * A NULL `initiated_by` IS NOT 'agent'. Every conversation created before
   * that column existed carries null, and reading null as agent-initiated
   * would hold the entire historical backlog open.
   */
  it('closes when initiated_by is null', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'agent',
          lastMessageAt: LONG_AGO,
          initiatedBy: null,
          customerHasReplied: false,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(true);
  });
});

describe('the original four conditions still hold', () => {
  it.each([
    ['solved', 'a finished chat is never re-closed'],
    ['closed', 'nor a closed one'],
  ])('leaves a %s chat alone (%s)', (status) => {
    expect(
      shouldCloseForIdle(
        { status, lastSenderType: 'agent', lastMessageAt: LONG_AGO, initiatedBy: 'agent' },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(false);
  });

  it('never closes a chat waiting on US', () => {
    expect(
      shouldCloseForIdle(
        {
          status: 'open',
          lastSenderType: 'customer',
          lastMessageAt: LONG_AGO,
          initiatedBy: 'customer',
          customerHasReplied: true,
        },
        FIVE_MIN,
        NOW,
      ),
    ).toBe(false);
  });
});
