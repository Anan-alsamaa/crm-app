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
 * WeCare roles only, and ALWAYS ON (owner, 2026-10-22): the alerts exist so a
 * customer is never missed, so there is no switch to turn them off - and no
 * other role gets them (or the Windows permission prompt) at all.
 */
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

/** The roles new-chat alerts are for: WeCare Agent, Supervisor and Admin. */
export function receivesChatAlerts(roleName: string | null | undefined): boolean {
  return String(roleName ?? '')
    .trim()
    .toLowerCase()
    .startsWith('wecare');
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
 * permission request that no gesture started. Armed by ChatAlerts, which only
 * WeCare roles mount, so nobody else is ever asked.
 */
export function askDesktopPermissionOnce(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const askOnce = () => {
    if (desktopPermission() === 'default' && read(ASKED_KEY) !== '1') {
      void requestDesktopPermission();
    }
  };
  for (const ev of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(ev, askOnce, { once: true, passive: true });
  }
  return () => {
    for (const ev of ['pointerdown', 'keydown'] as const) {
      window.removeEventListener(ev, askOnce);
    }
  };
}
