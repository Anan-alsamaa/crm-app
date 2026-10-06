import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { welcomeLine } from '../src/Widget.js';

/**
 * THE OPENING BUBBLE IS THE BUILT-IN GREETING AGAIN (owner, 2026-10-06).
 *
 * "Exactly as we had before": the widget opens with its own "Welcome {name},
 * how can we help you?" (named for a returning customer, generic otherwise) in
 * the brand-tinted greeting style. Operations' "رسالة ترحيب" template is no
 * longer the opening bubble — the gateway SENDS it as a real agent-style
 * message after the customer's first message, so showing it here too would
 * make the customer read it twice.
 */

const TR = { welcomeNamed: 'Welcome {name}, how can we help you?', welcomeNew: 'Hey there 👋' };
const widget = readFileSync(resolve(import.meta.dirname, '../src/Widget.tsx'), 'utf8');
const socket = readFileSync(resolve(import.meta.dirname, '../src/socket.ts'), 'utf8');

describe('the opening greeting', () => {
  it('greets a new customer generically', () => {
    expect(welcomeLine(TR, { name: null, isNew: true })).toBe('Hey there 👋');
  });

  it('greets a returning customer by name', () => {
    expect(welcomeLine(TR, { name: 'Ayman', isNew: false })).toBe(
      'Welcome Ayman, how can we help you?',
    );
  });

  it('falls back to the generic line when there is no name', () => {
    expect(welcomeLine(TR, { name: null, isNew: false })).toBe('Hey there 👋');
    expect(welcomeLine(TR, { name: '   ', isNew: false })).toBe('Hey there 👋');
  });

  /* The regression: the template must not come back as the opening bubble. */
  it('takes no template at all', () => {
    expect(welcomeLine.length).toBe(2);
    expect(widget).not.toMatch(/setWelcome\(/);
    expect(socket).not.toMatch(/welcome\?: \{ ar: string \| null; en: string \| null \}/);
  });

  /* "The automated/system-style bubble (green highlight)": the local greeting
     keeps its own distinct style. */
  it('keeps the greeting highlight style', () => {
    expect(widget).toContain("m.id === GREETING_ID ? ' yiji-msg-greeting' : ''");
  });
});

describe('the sent welcome message is not proof of an agent', () => {
  /* It arrives whether anybody is online or not, so the "our team is offline"
     reassurance must survive it. */
  it('does not clear the offline notice or count as an answer', () => {
    expect(widget).toContain("const fromPerson = msg.senderType === 'agent' && !msg.automated;");
    expect(widget).toContain(
      "if (msg.senderType === 'agent' && !msg.automated) offlineNoticedRef.current = false;",
    );
    expect(widget).toContain(
      "const answered = history.some((m) => m.senderType === 'agent' && !m.automated);",
    );
  });

  it('carries the automated flag through history', () => {
    expect(socket).toContain('...(m.automated ? { automated: true } : {})');
  });
});
