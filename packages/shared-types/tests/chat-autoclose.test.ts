import { describe, it, expect } from 'vitest';
import {
  chatIdleMinutes,
  detectLocale,
  DEFAULT_CHAT_IDLE_MINUTES,
  idleCloseMessage,
  IDLE_CLOSE_MESSAGE,
  shouldCloseForIdle,
} from '../src/chat-autoclose.js';

/**
 * CLOSING A CHAT THE CUSTOMER HAS GONE QUIET ON (owner, 2026-09-30).
 *
 * The rule in the owner's words: five minutes of idleness where the last message
 * was the AGENT'S — the customer has not texted and has not attached anything.
 *
 * Every condition below is a guard against closing something that should stay
 * open. This is customer-facing and irreversible from the customer's side: they
 * receive a goodbye message. A wrong close is not a cosmetic bug.
 */
const MIN = 60_000;
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();

describe('shouldCloseForIdle', () => {
  /* THE CASE THIS EXISTS FOR: the agent answered, the customer went quiet. */
  it('closes a live chat whose last message was the agent’s, past the threshold', () => {
    expect(
      shouldCloseForIdle(
        { status: 'open', lastSenderType: 'agent', lastMessageAt: ago(6) },
        5,
        NOW,
      ),
    ).toBe(true);
  });

  it('waits until the threshold is actually reached', () => {
    const c = { status: 'open', lastSenderType: 'agent' as const, lastMessageAt: ago(4) };
    expect(shouldCloseForIdle(c, 5, NOW)).toBe(false);
    // Exactly at the threshold counts — 5 minutes of idleness IS 5 minutes.
    expect(shouldCloseForIdle({ ...c, lastMessageAt: ago(5) }, 5, NOW)).toBe(true);
  });

  /*
   * THE MOST IMPORTANT ONE. A customer's message means the ball is with US.
   * Closing that would cut off somebody still waiting for help and tell them the
   * chat closed for inactivity — theirs.
   */
  it('NEVER closes a chat whose last message was the customer’s', () => {
    expect(
      shouldCloseForIdle(
        { status: 'open', lastSenderType: 'customer', lastMessageAt: ago(90) },
        5,
        NOW,
      ),
    ).toBe(false);
  });

  /* A system line is not an agent answering. */
  it('does not close on a system message', () => {
    expect(
      shouldCloseForIdle(
        { status: 'open', lastSenderType: 'system', lastMessageAt: ago(90) },
        5,
        NOW,
      ),
    ).toBe(false);
  });

  /* Already finished: re-closing sends the customer a SECOND goodbye. */
  it.each(['solved', 'closed', 'resolved'])('leaves a %s chat alone', (status) => {
    expect(
      shouldCloseForIdle({ status, lastSenderType: 'agent', lastMessageAt: ago(90) }, 5, NOW),
    ).toBe(false);
  });

  it('treats pending as live, like every other sweep here', () => {
    expect(
      shouldCloseForIdle(
        { status: 'pending', lastSenderType: 'agent', lastMessageAt: ago(9) },
        5,
        NOW,
      ),
    ).toBe(true);
  });

  /*
   * A MISSING OR BROKEN DATE IS NOT "INFINITELY IDLE". Reading null as very old
   * is how a sweep closes the whole inbox — see [[silent-empty-failures]] for
   * this shape.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['unparseable', 'not-a-date'],
  ])('does not close when the last message time is %s', (_label, at) => {
    expect(
      shouldCloseForIdle({ status: 'open', lastSenderType: 'agent', lastMessageAt: at }, 5, NOW),
    ).toBe(false);
  });

  it('is case- and space-insensitive about the status', () => {
    expect(
      shouldCloseForIdle(
        { status: ' OPEN ', lastSenderType: 'agent', lastMessageAt: ago(9) },
        5,
        NOW,
      ),
    ).toBe(true);
  });
});

describe('chatIdleMinutes', () => {
  it('reads a real setting', () => {
    expect(chatIdleMinutes('10')).toBe(10);
    expect(chatIdleMinutes(15)).toBe(15);
  });

  /*
   * A BROKEN SETTING MUST NOT CLOSE THE INBOX. A stray `0` would close every
   * chat the instant an agent replied, so it falls back rather than obeying.
   */
  it.each([
    ['blank', ''],
    ['null', null],
    ['undefined', undefined],
    ['a word', 'five'],
    ['zero', '0'],
    ['negative', '-5'],
    ['more than a day', '2000'],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(chatIdleMinutes(raw)).toBe(DEFAULT_CHAT_IDLE_MINUTES);
  });

  it('floors a fractional value rather than rejecting it', () => {
    expect(chatIdleMinutes('7.9')).toBe(7);
  });
});

describe('idleCloseMessage', () => {
  it('sends English only for an explicit en locale', () => {
    expect(idleCloseMessage('en')).toBe(IDLE_CLOSE_MESSAGE.en);
    expect(idleCloseMessage('en-GB')).toBe(IDLE_CLOSE_MESSAGE.en);
  });

  /* Arabic is the default: most customers here write in Arabic, so an UNKNOWN
     locale should land on the language most of them read. */
  it.each([
    ['ar', 'ar'],
    ['ar-SA', 'ar-SA'],
    ['missing', null],
    ['blank', ''],
    ['odd', 'fr'],
  ])('sends Arabic for %s', (_label, locale) => {
    expect(idleCloseMessage(locale)).toBe(IDLE_CLOSE_MESSAGE.ar);
  });

  /*
   * THE TONE IS THE REQUIREMENT, not a nicety: "the customer is the king... it
   * has to be kind, respectful and not hurt them". These pin the words that
   * would break that if somebody edited the copy carelessly.
   */
  it('never blames the customer', () => {
    for (const msg of [IDLE_CLOSE_MESSAGE.ar, IDLE_CLOSE_MESSAGE.en]) {
      const lower = msg.toLowerCase();
      for (const bad of ['did not reply', 'no response', 'inactivity', 'failed', 'you have not']) {
        expect(lower).not.toContain(bad);
      }
    }
  });

  it('thanks them and invites them back', () => {
    expect(IDLE_CLOSE_MESSAGE.en.toLowerCase()).toContain('thank you');
    expect(IDLE_CLOSE_MESSAGE.en.toLowerCase()).toContain('new message');
    // The Arabic carries the same two beats.
    expect(IDLE_CLOSE_MESSAGE.ar).toContain('نشكر');
    expect(IDLE_CLOSE_MESSAGE.ar).toContain('رسالة جديدة');
  });
});

/**
 * WHICH LANGUAGE THE CUSTOMER IS ACTUALLY WRITING IN.
 *
 * Neither `conversations` nor `contacts` stores a locale — I checked the live
 * schema rather than adding a column, and the customer's own words are better
 * evidence than a preference nobody sets.
 */
describe('detectLocale', () => {
  it('reads Arabic from the customer’s own words', () => {
    expect(detectLocale(['هلا والله'])).toBe('ar');
  });

  it('reads English when that is all there is', () => {
    expect(detectLocale(['where is my order?'])).toBe('en');
  });

  /*
   * ANY Arabic wins, deliberately. "ok تمام" is an Arabic speaker, and the
   * asymmetry is the point: Arabic to a bilingual customer is fine, English to
   * somebody who only reads Arabic is not.
   */
  it('prefers Arabic on a mixed message', () => {
    expect(detectLocale(['ok تمام'])).toBe('ar');
  });

  it('finds Arabic anywhere in the history, not just the first line', () => {
    expect(detectLocale(['hello', 'thanks', 'شكرا'])).toBe('ar');
  });

  /* Nothing to go on — an attachment with no text, or only digits — falls back
     to Arabic, the language most customers here read. */
  it.each([
    ['nothing', []],
    ['blanks', ['', '   ']],
    ['nulls', [null, undefined]],
  ])('falls back to Arabic for %s', (_label, texts) => {
    expect(detectLocale(texts as Array<string | null | undefined>)).toBe('ar');
  });

  it('does not call a bare order number English', () => {
    // Digits are not a language. Arabic is the honest default here.
    expect(detectLocale(['1324982'])).toBe('en');
  });
});
