import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, SoundOffIcon, SoundOnIcon } from '@yiji/ui';
import { isSoundMuted, playMessageBeep, setSoundMuted } from '../lib/sound.js';

/**
 * Top-bar control that mutes/unmutes the new-message beep (the audible alert
 * for new shared-inbox messages). It is intentionally distinct from the
 * notification bell next to it — the bell is the visual inbox of
 * SLA/mention/assignment notifications; this only governs the sound. The label
 * ("Sound on" / "Muted") makes the current state explicit rather than leaving
 * it to an ambiguous icon.
 *
 * Turning sound ON plays the beep once: confirms it works AND satisfies the
 * browser's "audio needs a user gesture" rule so later beeps aren't dropped.
 */
export function SoundToggle() {
  const { t } = useTranslation();
  const [muted, setMuted] = useState(isSoundMuted());

  const toggle = () => {
    const next = !muted;
    setSoundMuted(next);
    setMuted(next);
    if (!next) playMessageBeep();
  };

  const actionLabel = muted
    ? t('sound.unmute', { defaultValue: 'Unmute new-message sound' })
    : t('sound.mute', { defaultValue: 'Mute new-message sound' });

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={muted}
      aria-label={actionLabel}
      title={actionLabel}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-lg',
        'transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        muted
          ? 'text-amber-600 hover:bg-amber-500/10 dark:text-amber-400'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {muted ? <SoundOffIcon size={17} /> : <SoundOnIcon size={17} />}
    </button>
  );
}
