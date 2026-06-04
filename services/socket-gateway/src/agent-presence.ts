/**
 * Agent presence — global across vendors.
 *
 * We count DISTINCT logged-in agents, not raw sockets, so the customer page
 * shows "online" if at least one agent is signed in anywhere — regardless
 * of how many tabs or devices that agent has open, and regardless of how
 * many other agents are simultaneously online. The operational rule, in
 * code form:
 *
 *   online  ⇔  ∃ agent A : refCount(A) > 0   OR   pendingOfflineTimer(A)
 *
 * State (per gateway instance):
 *   - agentSocketUser[socketId] → userId. So a disconnect knows whose
 *     refCount to decrement without re-reading socket.data.
 *   - agentRefCount[userId] → live socket count. Entry presence (not the
 *     value) defines "currently online" — entries are only deleted by the
 *     offline finaliser, never when count hits zero. That keeps an agent
 *     counted during the OFFLINE_GRACE window so a reload or short network
 *     drop doesn't flicker the host page to offline and back.
 *   - agentOfflineTimers[userId] → pending offline timer. Cleared on
 *     reconnect-within-grace so the broadcast never fires.
 *
 * Behaviour summary for the multi-agent case:
 *
 *   Agent A signs in          → refCount {A:1}            → broadcast 1
 *   Agent B signs in          → refCount {A:1, B:1}       → broadcast 2
 *   Agent B opens 2nd tab     → refCount {A:1, B:2}       → silent
 *   Agent B closes a tab      → refCount {A:1, B:1}       → silent
 *   Agent A signs out         → refCount {B:1}            → broadcast 1
 *   Agent B signs out         → refCount {}               → broadcast 0
 *
 * The widget shows "offline" only when broadcast count reaches 0 — i.e.
 * when no agent has any live tab anywhere.
 */

const DEFAULT_OFFLINE_GRACE_MS = 5000;

export interface AgentPresenceOptions {
  /** Grace window (ms) before a transport-level disconnect declares offline. */
  offlineGraceMs?: number;
  /** Schedule a deferred callback. Injectable for tests. */
  setTimer?: typeof setTimeout;
  /** Cancel a deferred callback. Injectable for tests. */
  clearTimer?: typeof clearTimeout;
}

export interface AgentPresenceSnapshot {
  distinctOnline: number;
  agents: Array<{ userId: string; sockets: number; pendingOffline: boolean }>;
}

export interface AgentPresenceTracker {
  /** Add a socket. Returns true ONLY for brand-new agents (presence changed). */
  add(socketId: string, userId: string): boolean;
  /**
   * Drop a socket.
   *   immediate=false (transport disconnect): schedules the OFFLINE_GRACE
   *     finaliser. Callers MUST NOT broadcast — the finaliser calls
   *     `onOffline` when (and if) the agent really goes offline.
   *   immediate=true  (explicit logout): bypasses grace, deletes the entry
   *     and returns true so the caller broadcasts now.
   */
  remove(socketId: string, immediate: boolean, onOffline: () => void): boolean;
  /** All socket IDs currently tracked for this user. */
  socketsForUser(userId: string): string[];
  /** Number of distinct online agents (entries in refCount). */
  distinctOnline(): number;
  /** Read-only snapshot for diagnostics. */
  snapshot(): AgentPresenceSnapshot;
}

export function createAgentPresence(opts: AgentPresenceOptions = {}): AgentPresenceTracker {
  const offlineGraceMs = opts.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;

  const socketUser = new Map<string, string>();
  const refCount = new Map<string, number>();
  const offlineTimers = new Map<string, ReturnType<typeof setTimer>>();

  function add(socketId: string, userId: string): boolean {
    socketUser.set(socketId, userId);
    const pending = offlineTimers.get(userId);
    if (pending) {
      clearTimer(pending);
      offlineTimers.delete(userId);
    }
    const wasTracked = refCount.has(userId);
    refCount.set(userId, (refCount.get(userId) ?? 0) + 1);
    return !wasTracked;
  }

  function remove(socketId: string, immediate: boolean, onOffline: () => void): boolean {
    const userId = socketUser.get(socketId);
    if (!userId) return false;
    socketUser.delete(socketId);
    const next = (refCount.get(userId) ?? 1) - 1;
    if (next > 0) {
      refCount.set(userId, next);
      return false;
    }
    refCount.set(userId, 0);

    if (immediate) {
      const pending = offlineTimers.get(userId);
      if (pending) {
        clearTimer(pending);
        offlineTimers.delete(userId);
      }
      refCount.delete(userId);
      return true;
    }

    const existing = offlineTimers.get(userId);
    if (existing) clearTimer(existing);
    const t = setTimer(() => {
      offlineTimers.delete(userId);
      if ((refCount.get(userId) ?? 0) > 0) return;
      refCount.delete(userId);
      onOffline();
    }, offlineGraceMs);
    offlineTimers.set(userId, t);
    return false;
  }

  function socketsForUser(userId: string): string[] {
    const out: string[] = [];
    for (const [sid, uid] of socketUser.entries()) {
      if (uid === userId) out.push(sid);
    }
    return out;
  }

  function distinctOnline(): number {
    return refCount.size;
  }

  function snapshot(): AgentPresenceSnapshot {
    const agents: Array<{ userId: string; sockets: number; pendingOffline: boolean }> = [];
    for (const [userId, count] of refCount.entries()) {
      agents.push({ userId, sockets: count, pendingOffline: offlineTimers.has(userId) });
    }
    return { distinctOnline: distinctOnline(), agents };
  }

  return { add, remove, socketsForUser, distinctOnline, snapshot };
}
