/**
 * New-message notification beep. Synthesized with the Web Audio API so we ship
 * no audio asset. Muting is persisted; the agent toggles it from the rail.
 *
 * Self-send suppression: the gateway broadcasts `inbox:activity` for the agent's
 * OWN replies too, so we skip the beep for a short window after the agent sends.
 */

const KEY = 'yiji.agent.soundMuted';

let muted = typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1';
let lastSelfSend = 0;
let ctx: AudioContext | null = null;

export function isSoundMuted(): boolean {
  return muted;
}

export function setSoundMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable — keep the in-memory value */
  }
}

/** Mark that the agent just sent, so the echoed inbox activity doesn't beep. */
export function noteSelfSend(): void {
  lastSelfSend = Date.now();
}

/**
 * UNLOCK THE AUDIO ON THE FIRST GESTURE, AND KEEP IT UNLOCKED.
 *
 * A browser starts an AudioContext SUSPENDED and only lets `resume()` succeed
 * inside a user gesture. `playMessageBeep` called resume() and carried on — the
 * oscillator was scheduled against a context that never started, so nothing was
 * heard and nothing failed. That is why the beep was unreliable.
 *
 * Creating and resuming the context on the agent's first click or keypress
 * means it is already running by the time a chat arrives. Browsers also suspend
 * it again when a tab is hidden, so the beep re-resumes below — a resume on a
 * context that has ALREADY been unlocked once is permitted even in the
 * background, which is what makes a background tab audible.
 */
function unlock(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx ?? new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* audio unavailable — the beep will simply be silent */
  }
}

if (typeof window !== 'undefined') {
  // `once` per event: after the first gesture the context is live for the
  // session, and re-running this on every click would be noise.
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, unlock, { once: true, passive: true });
  }
  /* Coming back to the tab is also a good moment to make sure the context did
     not get suspended while it was hidden. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') unlock();
  });
}

export function playMessageBeep(): void {
  if (muted) return;
  if (Date.now() - lastSelfSend < 1500) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx ?? new Ctor();
    /*
     * A HIDDEN TAB SUSPENDS THE CONTEXT. Resume, and SCHEDULE AFTER IT IS
     * RUNNING — the old code called resume() and immediately read
     * `currentTime`, which on a suspended context does not advance, so the
     * beep was scheduled into a clock that was not moving. The agent heard
     * nothing, with no error: exactly the complaint that the sound does not
     * play when the CRM is in the background (owner, 2026-09-16).
     */
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => beep());
      return;
    }
    beep();
  } catch {
    /* audio blocked or unavailable — silently skip */
  }
}

/** The chirp itself, on a context that is known to be running. */
function beep(): void {
  try {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // A friendly rising two-note chirp.
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1318, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.26);
  } catch {
    /* audio blocked or unavailable — silently skip */
  }
}
