/**
 * New-chat alerts (owner, 2026-10-13): "when the agents are busy with other
 * tasks and the customer sends a message, it goes unnoticed — the headphones
 * may be connected." The beep alone is not enough, so a customer message also
 * raises
 *  - a card in the CENTRE of the portal (ChatAlerts), and
 *  - a Windows notification that STAYS until clicked, for when the agent is in
 *    another program or tab. A web page cannot draw outside its own window;
 *    the system notification is the only surface that reaches past it.
 *
 * The on/off switch is per browser, like the sound mute.
 */
const KEY = 'yiji.agent.chatAlerts';
const ASKED_KEY = 'yiji.agent.chatAlertsAsked';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — keep the default */
  }
}

let enabled = typeof window !== 'undefined' && read(KEY) !== 'off';

export function chatAlertsEnabled(): boolean {
  return enabled;
}

export function setChatAlertsEnabled(value: boolean): void {
  enabled = value;
  write(KEY, value ? 'on' : 'off');
}

export type DesktopPermission = NotificationPermission | 'unsupported';

export function desktopPermission(): DesktopPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (desktopPermission() === 'unsupported') return 'unsupported';
  write(ASKED_KEY, '1');
  try {
    return await Notification.requestPermission();
  } catch {
    return desktopPermission();
  }
}

/*
 * Ask ONCE, on the agent's first click or key press. Browsers quietly block a
 * permission request that no gesture started, and an agent who never finds
 * the bell button would otherwise never be asked at all.
 */
if (typeof window !== 'undefined') {
  const askOnce = () => {
    if (enabled && desktopPermission() === 'default' && read(ASKED_KEY) !== '1') {
      void requestDesktopPermission();
    }
  };
  for (const ev of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(ev, askOnce, { once: true, passive: true });
  }
}
