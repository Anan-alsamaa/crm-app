import { describe, expect, it, vi } from 'vitest';
import { createAgentPresence } from '../src/agent-presence.js';

/**
 * Behavioural unit tests for the agent-presence state machine. The customer-
 * facing rule we promise on the host page is:
 *
 *   The widget shows "offline" if and only if NO agent is signed in
 *   anywhere — across all agents, all devices, and all tabs.
 *
 * These tests pin that promise with concrete scenarios so future refactors
 * cannot regress it silently.
 */
describe('agentPresence', () => {
  it('multiple agents: one logging out leaves widget online while others are still signed in', () => {
    const p = createAgentPresence();

    // Agent A signs in from device 1.
    expect(p.add('A-sock-1', 'agentA')).toBe(true);
    expect(p.distinctOnline()).toBe(1);

    // Agent B signs in from a different device — distinct count goes to 2.
    expect(p.add('B-sock-1', 'agentB')).toBe(true);
    expect(p.distinctOnline()).toBe(2);

    // Agent C signs in too — still online.
    expect(p.add('C-sock-1', 'agentC')).toBe(true);
    expect(p.distinctOnline()).toBe(3);

    // Agent B explicitly logs out. Distinct count drops to 2 BUT broadcast
    // call returns true (a presence change happened), and crucially the
    // count is NOT zero — the widget should still read "online".
    let broadcast = false;
    expect(
      p.remove('B-sock-1', /*immediate*/ true, () => {
        broadcast = true;
      }),
    ).toBe(true);
    expect(p.distinctOnline()).toBe(2); // A and C still here
    expect(broadcast).toBe(false); // immediate path uses the returned bool, not the cb

    // Agent A logs out. Still online via C.
    expect(p.remove('A-sock-1', true, () => undefined)).toBe(true);
    expect(p.distinctOnline()).toBe(1);

    // Only Agent C left — they log out. Now and only now should the count
    // reach zero, which the customer page reads as "offline".
    expect(p.remove('C-sock-1', true, () => undefined)).toBe(true);
    expect(p.distinctOnline()).toBe(0);
  });

  it('one agent with multiple tabs: closing one tab stays online; closing the last drops after grace', () => {
    vi.useFakeTimers();
    try {
      const p = createAgentPresence({ offlineGraceMs: 5000 });

      // Three tabs for the same agent.
      expect(p.add('A-tab-1', 'agentA')).toBe(true);
      expect(p.add('A-tab-2', 'agentA')).toBe(false); // not a new agent
      expect(p.add('A-tab-3', 'agentA')).toBe(false);
      expect(p.distinctOnline()).toBe(1);

      // Two tabs close (transport disconnect, not explicit logout).
      p.remove('A-tab-1', false, () => undefined);
      p.remove('A-tab-2', false, () => undefined);
      expect(p.distinctOnline()).toBe(1); // last tab still alive

      // Last tab closes — grace timer starts. Count must stay 1 during grace.
      let offlineFired = false;
      p.remove('A-tab-3', false, () => {
        offlineFired = true;
      });
      expect(p.distinctOnline()).toBe(1); // still counted during grace
      expect(offlineFired).toBe(false);

      // Advance just under the grace window — still online.
      vi.advanceTimersByTime(4999);
      expect(offlineFired).toBe(false);
      expect(p.distinctOnline()).toBe(1);

      // Advance past the grace window — offline broadcast fires.
      vi.advanceTimersByTime(2);
      expect(offlineFired).toBe(true);
      expect(p.distinctOnline()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reload during grace window cancels the offline broadcast', () => {
    vi.useFakeTimers();
    try {
      const p = createAgentPresence({ offlineGraceMs: 5000 });

      p.add('old-sock', 'agentA');
      let offlineFired = false;
      p.remove('old-sock', false, () => {
        offlineFired = true;
      });

      // Page reload mints a new socket inside the grace window.
      vi.advanceTimersByTime(1000);
      expect(p.add('new-sock', 'agentA')).toBe(false); // returning agent — no broadcast
      expect(p.distinctOnline()).toBe(1);

      // Even if we run past the original grace window, the timer is gone.
      vi.advanceTimersByTime(10_000);
      expect(offlineFired).toBe(false);
      expect(p.distinctOnline()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit logout bypasses the grace window', () => {
    vi.useFakeTimers();
    try {
      const p = createAgentPresence({ offlineGraceMs: 5000 });

      p.add('A-tab-1', 'agentA');
      // Explicit logout — should drop immediately, not wait 5s.
      expect(p.remove('A-tab-1', /*immediate*/ true, () => undefined)).toBe(true);
      expect(p.distinctOnline()).toBe(0);

      // Confirm no stray timer fires later that could clobber state.
      vi.advanceTimersByTime(10_000);
      expect(p.distinctOnline()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('socketsForUser returns every socket id for a given agent', () => {
    const p = createAgentPresence();
    p.add('s1', 'agentA');
    p.add('s2', 'agentA');
    p.add('s3', 'agentB');
    expect(p.socketsForUser('agentA').sort()).toEqual(['s1', 's2']);
    expect(p.socketsForUser('agentB')).toEqual(['s3']);
    expect(p.socketsForUser('agentC')).toEqual([]);
  });

  it('snapshot exposes refCount and pending offline state for diagnostics', () => {
    vi.useFakeTimers();
    try {
      const p = createAgentPresence({ offlineGraceMs: 5000 });
      p.add('s1', 'agentA');
      p.add('s2', 'agentA');
      p.add('s3', 'agentB');

      // Agent B's only tab drops — pending offline.
      p.remove('s3', false, () => undefined);

      const snap = p.snapshot();
      expect(snap.distinctOnline).toBe(2);
      const a = snap.agents.find((x) => x.userId === 'agentA');
      const b = snap.agents.find((x) => x.userId === 'agentB');
      expect(a).toMatchObject({ sockets: 2, pendingOffline: false });
      expect(b).toMatchObject({ sockets: 0, pendingOffline: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
