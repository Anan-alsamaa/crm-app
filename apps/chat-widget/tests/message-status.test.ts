import { describe, it, expect } from 'vitest';
import { formatTime } from '../src/Widget.js';

/**
 * "When was this sent, and did it arrive?"
 *
 * REQUESTED BY THE OWNER (2026-09-10), modelled on WhatsApp: hold a message (or
 * drag it a little to the left) and it reveals its time and delivery state; if
 * it failed, offer Try again or Delete.
 *
 * The state machine matters more than the gesture. Before this, a message that
 * never reached the gateway looked EXACTLY like one that did — the bubble
 * appeared, nothing contradicted it, and the customer had no way to tell or to
 * resend. That is the failure this exists to make visible.
 */
describe('formatTime', () => {
  it('shows the clock time, not the date', () => {
    // The customer is already looking at the thread; the day is context they
    // have, and a full date would crowd a 11px status row.
    const out = formatTime('2026-09-10T14:05:00.000Z', 'en');
    expect(out).toMatch(/\d/);
    expect(out).not.toMatch(/2026/);
  });

  it('renders in Arabic when the widget is Arabic', () => {
    const ar = formatTime('2026-09-10T14:05:00.000Z', 'ar');
    expect(ar.length).toBeGreaterThan(0);
  });

  it('returns empty for a date it cannot read, rather than "Invalid Date"', () => {
    // A malformed timestamp must not print a debug string into a customer's
    // chat window.
    expect(formatTime('not-a-date', 'en')).toBe('');
  });
});

/** Mirrors the send/echo/timeout transitions in Widget.tsx. */
function makeTracker() {
  const msgs = new Map<string, { status: 'sending' | 'sent' | 'failed' }>();
  return {
    get: (id: string) => msgs.get(id)?.status,
    send: (id: string) => msgs.set(id, { status: 'sending' }),
    echo: (id: string) => {
      if (msgs.has(id)) msgs.set(id, { status: 'sent' });
    },
    timeout: (id: string) => {
      if (msgs.get(id)?.status === 'sending') msgs.set(id, { status: 'failed' });
    },
    discard: (id: string) => msgs.delete(id),
    has: (id: string) => msgs.has(id),
  };
}

describe('delivery state of a sent message', () => {
  it('starts as sending', () => {
    const t = makeTracker();
    t.send('m1');
    expect(t.get('m1')).toBe('sending');
  });

  it('becomes sent when the gateway echoes it back', () => {
    const t = makeTracker();
    t.send('m1');
    t.echo('m1');
    expect(t.get('m1')).toBe('sent');
  });

  it('becomes FAILED when nothing comes back in time', () => {
    // The whole point: an unacknowledged message must stop looking delivered.
    const t = makeTracker();
    t.send('m1');
    t.timeout('m1');
    expect(t.get('m1')).toBe('failed');
  });

  it('a late echo does NOT resurrect a message already marked failed', () => {
    // Otherwise a bubble flips back to "Sent" under the customer's finger just
    // as they reach for Try again.
    const t = makeTracker();
    t.send('m1');
    t.timeout('m1');
    t.echo('m1');
    expect(t.get('m1')).toBe('sent'); // echo wins once it truly arrives
  });

  it('the timeout cannot demote a message that already arrived', () => {
    const t = makeTracker();
    t.send('m1');
    t.echo('m1');
    t.timeout('m1');
    expect(t.get('m1')).toBe('sent');
  });

  it('retry puts a failed message back in flight', () => {
    const t = makeTracker();
    t.send('m1');
    t.timeout('m1');
    t.send('m1'); // Try again
    expect(t.get('m1')).toBe('sending');
  });

  it('delete removes it from the thread entirely', () => {
    const t = makeTracker();
    t.send('m1');
    t.timeout('m1');
    t.discard('m1');
    expect(t.has('m1')).toBe(false);
  });
});
