import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldOfferWhatsAppNudge } from '../src/features/conversation/PushUnreachableNotice.js';

/**
 * WHEN TO OFFER A WHATSAPP NUDGE (EMA-11).
 *
 * About a third of customers cannot receive a push (measured: 39 conversations
 * in 14 days; **20 production conversations carry `push_unreachable_at`
 * today**). For an AGENT-INITIATED chat that is the whole problem — the
 * customer has no window open, so the push was the only thing telling them to
 * look, and without it the agent writes into a thread nobody will ever see.
 *
 * Three conditions, and each one prevents a real misfire rather than being
 * defensive padding. They are pinned here because getting any of them wrong is
 * invisible: the notice simply appears, or fails to, on the wrong chats.
 */

const base = {
  pushUnreachableAt: '2026-10-04T10:00:00Z',
  initiatedBy: 'agent' as const,
  phone: '0501234567',
};

describe('offering the nudge', () => {
  it('offers it on an agent-started chat the customer cannot be pushed on', () => {
    expect(shouldOfferWhatsAppNudge(base)).toBe(true);
  });

  /* THE ORDINARY CASE. Most customers are reachable, and there is nothing to
     say about them. */
  it.each([null, undefined, ''])('stays silent when the push works (%s)', (v) => {
    expect(shouldOfferWhatsAppNudge({ ...base, pushUnreachableAt: v })).toBe(false);
  });

  /*
   * THE CUSTOMER STARTED IT — they are already looking at the chat. Telling
   * their agent that notifications are broken helps nobody, and because a third
   * of customers are unreachable it would appear on a third of the inbox.
   */
  it('stays silent on a chat the customer started', () => {
    expect(shouldOfferWhatsAppNudge({ ...base, initiatedBy: 'customer' })).toBe(false);
  });

  /*
   * AND AN ABSENT VALUE IS CUSTOMER-STARTED, not agent. `initiated_by` defaults
   * to `customer` in the schema, and every conversation that predates the
   * column is one the customer opened. Treating a null as "agent" would light
   * the notice up across the whole history.
   */
  it.each([null, undefined])('treats an absent initiated_by as customer-started (%s)', (v) => {
    expect(shouldOfferWhatsAppNudge({ ...base, initiatedBy: v })).toBe(false);
  });

  /*
   * NO USABLE NUMBER, NOTHING TO OPEN. A `wa.me` link needs a Saudi mobile;
   * offering a button that opens nothing is worse than offering none — it is
   * the dead-button shape this codebase keeps reporting.
   */
  it.each([null, undefined, '', '   ', 'not-a-phone', '+447700900123'])(
    'stays silent without a usable Saudi mobile (%s)',
    (v) => {
      expect(shouldOfferWhatsAppNudge({ ...base, phone: v })).toBe(false);
    },
  );

  /* The shapes an agent or an import actually produces all resolve. */
  it.each(['0501234567', '+966501234567', '966501234567', '501234567'])('accepts %s', (phone) => {
    expect(shouldOfferWhatsAppNudge({ ...base, phone })).toBe(true);
  });
});

/**
 * AND THE NUDGE POINTS BACK INTO THE CRM.
 *
 * This is the design, not a detail. Push and WhatsApp are different mechanisms:
 * **push brings the customer back into the CRM chat; WhatsApp pulls the
 * conversation out of it.** A nudge that reads like an invitation to chat on
 * WhatsApp would move support into a channel the CRM cannot see, measure for
 * SLA or report on — quietly undoing the one-chat-surface work.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, '../src/features/conversation/PushUnreachableNotice.tsx'),
  'utf8',
);

describe('what the nudge says and does', () => {
  it('tells the customer to reply in the app', () => {
    expect(SRC).toMatch(/please open the app to read it and reply there/i);
  });

  it('opens wa.me with the message pre-drafted', () => {
    expect(SRC).toMatch(/https:\/\/wa\.me\/\$\{number\}\?text=\$\{encodeURIComponent\(message\)\}/);
  });

  /* The same number rule the ticket page has used since the ops portal proved
     it out — two copies of a phone rule is how one quietly stops matching. */
  it('reuses the shared Saudi number helper', () => {
    expect(SRC).toMatch(/import \{ saudiWaNumber \} from '\.\.\/tickets\/whatsapp\.js'/);
  });

  /* A link, so a middle-click or long-press behaves like every other outbound
     link rather than swallowing the gesture. */
  it('is a real link, not a button', () => {
    expect(SRC).toMatch(/target="_blank"/);
    expect(SRC).toMatch(/rel="noreferrer noopener"/);
  });
});

/**
 * THE DATA HAS TO REACH THE COMPONENT.
 *
 * Both columns exist in staging AND production — verified against the live
 * `/fields/conversations` — but the portal was not asking for them. A field
 * that exists and is never selected reads as `undefined`, which here means the
 * notice silently never appears: the exact shape this codebase keeps producing.
 */
const API = readFileSync(resolve(import.meta.dirname, '../src/features/inbox/api.ts'), 'utf8');

describe('the conversation query', () => {
  it('asks for both columns', () => {
    expect(API).toMatch(/'push_unreachable_at',/);
    expect(API).toMatch(/'initiated_by',/);
  });

  it('types them on the conversation', () => {
    expect(API).toMatch(/push_unreachable_at\?: string \| null/);
    expect(API).toMatch(/initiated_by\?: 'customer' \| 'agent' \| null/);
  });
});
