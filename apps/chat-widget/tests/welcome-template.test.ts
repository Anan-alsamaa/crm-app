import { describe, it, expect } from 'vitest';
import { welcomeLine } from '../src/Widget.js';

/**
 * THE WELCOME LINE COMES FROM OPERATIONS' OWN TEMPLATE.
 *
 * Asked for 2026-10-04: *"The automatic message shown once the customer sends
 * their first message should come from: رسالة ترحيب"* — a named row operations
 * maintain in the quick-replies library, not strings compiled into the widget.
 *
 * Pinned here rather than at the component, because the greeting is built in
 * TWO places — when `ready` arrives and again when the customer flips the
 * language — and the bug this replaces is exactly those two drifting apart.
 */

const TR = { welcomeNamed: 'Welcome {name}, how can we help you?', welcomeNew: 'Hey there 👋' };
const NEW = { name: null, isNew: true };
const RETURNING = { name: 'Ayman', isNew: false };

describe('with no template configured', () => {
  /* UNCHANGED BEHAVIOUR, and that matters: until operations create the row,
     and on any CRM where they never do, the widget must read exactly as it
     did before. */
  it('greets a new customer generically', () => {
    expect(welcomeLine(TR, 'en', NEW)).toBe('Hey there 👋');
    expect(welcomeLine(TR, 'en', NEW, null)).toBe('Hey there 👋');
    expect(welcomeLine(TR, 'en', NEW, { ar: null, en: null })).toBe('Hey there 👋');
  });

  it('greets a returning customer by name', () => {
    expect(welcomeLine(TR, 'en', RETURNING)).toBe('Welcome Ayman, how can we help you?');
  });

  /* A returning customer with no name on file is not a named greeting with a
     hole in it. */
  it('falls back to the generic line when there is no name', () => {
    expect(welcomeLine(TR, 'en', { name: null, isNew: false })).toBe('Hey there 👋');
    expect(welcomeLine(TR, 'en', { name: '   ', isNew: false })).toBe('Hey there 👋');
  });
});

describe('with a template configured', () => {
  const W = { ar: 'أهلًا بك في يجي', en: 'Thanks for reaching out!' };

  /* THE TEMPLATE WINS OUTRIGHT. It is operations' wording to choose. */
  it('uses the template for the current language', () => {
    expect(welcomeLine(TR, 'en', NEW, W)).toBe('Thanks for reaching out!');
    expect(welcomeLine(TR, 'ar', NEW, W)).toBe('أهلًا بك في يجي');
  });

  /* Including for a returning customer: a template with no placeholder reads
     the same for everybody, which is a legitimate choice, not a fault. */
  it('uses the template for a returning customer too', () => {
    expect(welcomeLine(TR, 'en', RETURNING, W)).toBe('Thanks for reaching out!');
  });

  /* One language configured, the other not: each falls back on its own. */
  it('falls back per language', () => {
    const arOnly = { ar: 'أهلًا', en: null };
    expect(welcomeLine(TR, 'ar', NEW, arOnly)).toBe('أهلًا');
    expect(welcomeLine(TR, 'en', NEW, arOnly)).toBe('Hey there 👋');
  });

  /* Whitespace is not a template. An operator who clears the field has
     withdrawn it, and must get the built-in wording back rather than a blank
     bubble. */
  it('ignores a blank template', () => {
    expect(welcomeLine(TR, 'en', NEW, { ar: null, en: '   ' })).toBe('Hey there 👋');
  });
});

describe('the {name} placeholder inside a template', () => {
  const W = { ar: 'مرحبًا {name}، كيف نساعدك؟', en: 'Welcome {name}, how can we help?' };

  it('substitutes the name when there is one', () => {
    expect(welcomeLine(TR, 'en', RETURNING, W)).toBe('Welcome Ayman, how can we help?');
    expect(welcomeLine(TR, 'ar', RETURNING, W)).toBe('مرحبًا Ayman، كيف نساعدك؟');
  });

  it('substitutes every occurrence', () => {
    const twice = { ar: null, en: 'Hi {name}. How can we help, {name}?' };
    expect(welcomeLine(TR, 'en', RETURNING, twice)).toBe('Hi Ayman. How can we help, Ayman?');
  });

  /*
   * AND NEVER SHOWS THE PLACEHOLDER ITSELF.
   *
   * "Welcome {name}, how can we help?" arriving at a customer is the kind of
   * visible breakage that makes a team stop editing templates — so with no
   * name on file the placeholder goes, and the punctuation left clinging to it
   * goes with it rather than leaving "Welcome , how can we help?".
   */
  it('removes the placeholder and its trailing comma when there is no name', () => {
    expect(welcomeLine(TR, 'en', NEW, W)).toBe('Welcome, how can we help?');
  });

  /* The ARABIC comma too — a different codepoint, and the one that would
     actually be left behind in the Arabic template. */
  it('removes the Arabic comma as well', () => {
    expect(welcomeLine(TR, 'ar', NEW, W)).toBe('مرحبًا، كيف نساعدك؟');
  });

  it('leaves no double space behind', () => {
    const mid = { ar: null, en: 'Hello {name} and welcome' };
    expect(welcomeLine(TR, 'en', NEW, mid)).toBe('Hello and welcome');
  });
});
