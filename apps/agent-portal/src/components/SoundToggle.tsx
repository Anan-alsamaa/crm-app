import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, SoundOffIcon, SoundOnIcon } from '@yiji/ui';
import { isSoundMuted, playMessageBeep, setSoundMuted } from '../lib/sound.js';

/**
 * Rail control to mute/unmute the new-message notification beep.
 *
 * Clarity matters here — a bare icon that swaps between "on" and "off" leaves
 * you guessing which state you're in. So:
 *  - expanded rail → icon + an explicit state label ("Sound on" / "Muted"),
 *  - collapsed rail → icon only, but the muted state is tinted + struck so
 *    it reads at a glance,
 *  - unmuting plays the beep once, which both confirms it works AND satisfies
 *    the browser's "audio needs a user gesture" rule so later beeps aren't
 *    silently dropped.
 */
export function SoundToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const [muted, setMuted] = useState(isSoundMuted());

  const toggle = () => {
    const next = !muted;
    setSoundMuted(next);
    setMuted(next);
    if (!next) playMessageBeep();
  };

  const actionLabel = muted
    ? t('sound.unmute', { defaultValue: 'Unmute notifications' })
    : t('sound.mute', { defaultValue: 'Mute notifications' });
  const stateLabel = muted
    ? t('sound.statusMuted', { defaultValue: 'Muted' })
    : t('sound.statusOn', { defaultValue: 'Sound on' });

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-pressed={muted}
        aria-label={actionLabel}
        title={actionLabel}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md transition-[background-color,color] duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
          muted
            ? 'text-amber-300/90 hover:bg-current/10'
            : 'text-current/80 hover:bg-current/10 hover:text-current',
        )}
      >
        {muted ? <SoundOffIcon size={16} /> : <SoundOnIcon size={16} />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={muted}
      aria-label={actionLabel}
      title={actionLabel}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
        muted
          ? 'text-amber-300/90 hover:bg-current/10'
          : 'text-current/85 hover:bg-current/10 hover:text-current',
      )}
    >
      {muted ? <SoundOffIcon size={15} /> : <SoundOnIcon size={15} />}
      <span>{stateLabel}</span>
    </button>
  );
}
