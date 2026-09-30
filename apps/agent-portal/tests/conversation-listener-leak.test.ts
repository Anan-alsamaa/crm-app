import { describe, it, expect, vi } from 'vitest';

/**
 * A MESSAGE MUST NEVER APPEAR IN ANOTHER CUSTOMER'S CHAT (owner, 2026-09-30).
 *
 * Reported: Mohamed was answering 0566461807 and Shatha 0545198480 at the same
 * moment. Shatha's reply flashed for ~2 seconds inside Mohamed's open chat, then
 * moved to where it belonged when he switched threads.
 *
 * **The database was always correct.** Verified on production: every message is
 * stored against the right conversation. Only the screen lied — which is the
 * most alarming version of this bug, because it looks like one customer's
 * message reaching another.
 *
 * THE CAUSE: `ConversationView` attaches its socket listeners inside
 * `void (async () => { ... })()`. The cleanup that IIFE returned went to a
 * PROMISE, not to React, so React never called it. Every conversation switch
 * left `messageNew` attached, bound to a closure holding the PREVIOUS
 * conversation's id and the previous render's `setLive`.
 *
 * The guard `if (msg.conversationId !== conversationId) return` does not save
 * it: the stale handler's captured id MATCHES the arriving message, so the
 * guard passes and the stale `setLive` runs.
 *
 * These model the listener lifecycle directly. The component has no mount test,
 * and what matters is whether a handler survives the switch that should remove
 * it.
 */

/** The minimum of socket.io's emitter that this bug lives in. */
function makeSocket() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    on(ev: string, fn: (...a: unknown[]) => void) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(fn);
    },
    /** No `fn` removes EVERY listener for the event — socket.io's real behaviour. */
    off(ev: string, fn?: (...a: unknown[]) => void) {
      if (!fn) handlers.delete(ev);
      else handlers.get(ev)?.delete(fn);
    },
    emit(ev: string, ...a: unknown[]) {
      for (const fn of handlers.get(ev) ?? []) fn(...a);
    },
    count(ev: string) {
      return handlers.get(ev)?.size ?? 0;
    },
  };
}

/**
 * One mount of the effect. `register` is how the fix hands its detach to React;
 * the BUG is modelled by not registering it.
 */
function mountConversation(
  socket: ReturnType<typeof makeSocket>,
  conversationId: string,
  onMessage: (convId: string, body: string) => void,
  register: (detach: () => void) => void,
) {
  const onNew = (...a: unknown[]) => {
    const msg = a[0] as { conversationId: string; content: string };
    // The real guard, verbatim in effect: it compares against the CAPTURED id.
    if (msg.conversationId !== conversationId) return;
    onMessage(conversationId, msg.content);
  };
  socket.on('message:new', onNew);
  register(() => socket.off('message:new', onNew));
}

describe('switching conversations detaches the old listener', () => {
  it('leaves exactly one message:new listener after a switch', () => {
    const socket = makeSocket();
    const sink = vi.fn();
    /* A holder rather than a bare `let`: TypeScript narrows a variable only
       assigned inside a callback to `never`, and the point here is the
       lifecycle, not the narrowing. */
    const held: { detach: (() => void) | null } = { detach: null };
    const register = (d: () => void) => {
      held.detach = d;
    };

    mountConversation(socket, 'conv-A', sink, register);
    expect(socket.count('message:new')).toBe(1);

    // React unmounts the effect for A, then mounts it for B.
    held.detach?.();
    mountConversation(socket, 'conv-B', sink, register);

    // THE ASSERTION. Before the fix this was 2, and the stale one belonged to A.
    expect(socket.count('message:new')).toBe(1);
  });

  /*
   * THE REPORTED SYMPTOM. A message for the conversation the agent has LEFT
   * must not reach the component now showing a different one.
   */
  it("does not deliver conv-A's message after switching to conv-B", () => {
    const socket = makeSocket();
    const delivered: Array<[string, string]> = [];
    /* A holder rather than a bare `let`: TypeScript narrows a variable only
       assigned inside a callback to `never`, and the point here is the
       lifecycle, not the narrowing. */
    const held: { detach: (() => void) | null } = { detach: null };
    const register = (d: () => void) => {
      held.detach = d;
    };

    mountConversation(socket, 'conv-A', (c, b) => delivered.push([c, b]), register);
    held.detach?.();
    mountConversation(socket, 'conv-B', (c, b) => delivered.push([c, b]), register);

    socket.emit('message:new', { conversationId: 'conv-A', content: "Shatha's reply" });
    expect(delivered).toEqual([]);

    socket.emit('message:new', { conversationId: 'conv-B', content: 'meant for B' });
    expect(delivered).toEqual([['conv-B', 'meant for B']]);
  });

  /*
   * WITHOUT the detach — the bug exactly as it shipped. Kept so the test states
   * what was wrong, not merely that it is now right: the stale handler's
   * captured id MATCHES the arriving message, so the guard passes.
   */
  it('reproduces the leak when the cleanup never reaches React', () => {
    const socket = makeSocket();
    const delivered: Array<[string, string]> = [];
    const noop = () => {};

    mountConversation(socket, 'conv-A', (c, b) => delivered.push([c, b]), noop);
    mountConversation(socket, 'conv-B', (c, b) => delivered.push([c, b]), noop);

    expect(socket.count('message:new')).toBe(2);
    socket.emit('message:new', { conversationId: 'conv-A', content: "Shatha's reply" });
    // The message is delivered while the agent is looking at conv-B.
    expect(delivered).toEqual([['conv-A', "Shatha's reply"]]);
  });

  /*
   * `socket.off('connect')` with NO handler — which is what the previous partial
   * fix did — removes every connect listener on the SHARED socket, including
   * those belonging to the inbox, the notification bell and the sound.
   */
  it('removes only its own connect listener, not a sibling feature’s', () => {
    const socket = makeSocket();
    const mine = vi.fn();
    const sibling = vi.fn();
    socket.on('connect', mine);
    socket.on('connect', sibling);

    socket.off('connect', mine); // by reference, as the fix does
    socket.emit('connect');

    expect(mine).not.toHaveBeenCalled();
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('shows why the bare off() was wrong', () => {
    const socket = makeSocket();
    const sibling = vi.fn();
    socket.on('connect', () => {});
    socket.on('connect', sibling);

    socket.off('connect'); // the old code
    socket.emit('connect');

    // The sibling feature silently stopped reconnecting.
    expect(sibling).not.toHaveBeenCalled();
  });
});
