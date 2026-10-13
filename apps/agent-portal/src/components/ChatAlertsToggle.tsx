import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, InboxIcon } from '@yiji/ui';
import {
  chatAlertsEnabled,
  desktopPermission,
  requestDesktopPermission,
  setChatAlertsEnabled,
} from '../lib/chat-alerts.js';

/**
 * On/off for the new-chat alerts (centre card + Windows notification), beside
 * the sound toggle. Turning it on asks Windows for permission when it has not
 * been given; amber means alerts are off OR Windows is blocking them, and the
 * tooltip says which.
 */
export function ChatAlertsToggle() {
  const { t } = useTranslation();
  const [on, setOn] = useState(chatAlertsEnabled());
  const [perm, setPerm] = useState(desktopPermission());

  const toggle = async () => {
    const next = !on;
    setChatAlertsEnabled(next);
    setOn(next);
    if (next && perm === 'default') setPerm(await requestDesktopPermission());
  };

  const blocked = on && perm === 'denied';
  const label = !on
    ? t('chatAlerts.turnOn', { defaultValue: 'Turn on new-chat alerts' })
    : blocked
      ? t('chatAlerts.blocked', {
          defaultValue:
            'New-chat alerts are on, but Windows pop-ups are blocked for this site. Allow notifications in the browser’s site settings (the icon left of the address).',
        })
      : t('chatAlerts.turnOff', { defaultValue: 'Turn off new-chat alerts' });

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={cn(
        'relative inline-flex h-9 w-9 items-center justify-center rounded-lg',
        'transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        !on || blocked
          ? 'text-amber-600 hover:bg-amber-500/10 dark:text-amber-400'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <InboxIcon size={17} />
      {(!on || blocked) && (
        <span
          aria-hidden
          className="absolute end-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-500"
        />
      )}
    </button>
  );
}
