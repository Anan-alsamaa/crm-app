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

export function playMessageBeep(): void {
  if (muted) return;
  if (Date.now() - lastSelfSend < 1500) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx ?? new Ctor();
    // Browsers start the context suspended until a user gesture; resume is a
    // no-op once it's running.
    if (ctx.state === 'suspended') void ctx.resume();
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
