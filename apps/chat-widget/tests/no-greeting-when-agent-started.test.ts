import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * DO NOT GREET A CUSTOMER AN AGENT HAS ALREADY WRITTEN TO.
 *
 * Owner, 2026-10-05: *"when the agent sends the first message to the customer,
 * the auto first reply should not be sent."*
 *
 * The greeting is a LOCAL bubble the widget inserts on `ready`, and `ready`
 * fires BEFORE `messages:history`. So for an agent-initiated chat the order the
 * customer saw was:
 *
 *     [agent bubble]  "Hey there! How can we help?"      <- automated
 *     [agent bubble]  "Hello, this is WeCare about..."    <- a real person
 *
 * They tap a notification from a human being and read a machine's greeting
 * above it. Worse, both render as `senderType: 'agent'`, so there is nothing
 * on screen telling them one of the two was not written by anybody — the chat
 * appears to answer itself before the agent speaks.
 *
 * The fix is a fact sent on `ready`, not an instruction: the widget already
 * owns every other decision about which greeting a customer gets (named for a
 * returning customer, generic for a new one), and moving this one into the
 * gateway would split that rule across two services.
 */
const widget = readFileSync(resolve(import.meta.dirname, '../src/Widget.tsx'), 'utf8');
const socket = readFileSync(resolve(import.meta.dirname, '../src/socket.ts'), 'utf8');

describe('the widget suppresses its greeting for an agent-initiated chat', () => {
  it('reads the flag off the ready payload', () => {
    expect(widget).toMatch(/isNew,\s*\n\s*agentInitiated,/);
  });

  /*
   * Placed INSIDE the `setMessages` updater, after the already-greeted guard,
   * so it is evaluated against the live message list rather than a stale
   * closure — the same reason the duplicate check lives there.
   */
  it('returns the thread unchanged rather than inserting anything', () => {
    expect(widget).toMatch(/if \(agentInitiated\) return prev;/);
  });

  /*
   * AN EMPTY BUBBLE IS NOT A FIX. Rendering the greeting as '' would still
   * occupy a row in the thread and push the agent's real words down, which is
   * most of the harm the report was about.
   */
  it('does not fall back to an empty greeting bubble', () => {
    expect(widget).not.toMatch(/content: agentInitiated \? '' :/);
  });

  /* The guard must sit before the insert, not after it. */
  it('guards before building the message object', () => {
    const block = widget.match(/if \(agentInitiated\) return prev;[\s\S]{0,400}?id: GREETING_ID,/);
    expect(block, 'the guard should precede the GREETING_ID insert').not.toBeNull();
  });
});

describe('the ready payload carries the flag', () => {
  it('is typed on both ready declarations in socket.ts', () => {
    const hits = socket.match(/agentInitiated\?: boolean;/g) ?? [];
    expect(hits.length).toBe(2);
  });
});

describe('the language switch cannot resurrect it', () => {
  /*
   * `switchLocale` rewrites the greeting so the first line of the chat is not
   * left in the language the customer just left. It does so with `.map()` over
   * EXISTING messages, which is a no-op when no greeting bubble is present —
   * so it needs no agent-initiated check of its own.
   *
   * Pinned because changing that `.map()` to an insert-or-update (a natural
   * refactor) would quietly bring the greeting back on the first language
   * toggle, in the one case this fix exists to prevent.
   */
  it('maps over existing messages instead of inserting one', () => {
    const fn = widget.match(/const switchLocale = \(\) => \{[\s\S]*?\n {2}\};/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/prev\.map\(\(m\) => \(m\.id === GREETING_ID/);
    expect(fn![0]).not.toContain('...prev,');
  });
});
