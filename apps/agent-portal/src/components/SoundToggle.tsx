import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, SoundOffIcon, SoundOnIcon } from '@yiji/ui';
import { isSoundMuted, playMessageBeep, setSoundMuted } from '../lib/sound.js';

/**
 * Mute/unmute the new-message beep (the audible alert that plays when a new
 * message lands in the shared inbox). This is distinct from the notification
 * bell, which is the visual inbox of SLA/mention/assignment notifications —
 * so the expanded rail spells out exactly what it controls ("Message sounds")
 * with an On/Off segment, and the collapsed rail falls back to a tinted icon.
 *
 * Turning sound ON plays the beep once: it confirms it works AND satisfies the
 * browser's "audio needs a user gesture" rule so later beeps aren't dropped.
 */
export function SoundToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const [muted, setMuted] = useState(isSoundMuted());

  const setOn = (on: boolean) => {
    setSoundMuted(!on);
    setMuted(!on);
    if (on) playMessageBeep();
  };

  const actionLabel = muted
    ? t('sound.unmute', { defaultValue: 'Unmute new-message sound' })
    : t('sound.mute', { defaultValue: 'Mute new-message sound' });

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setOn(muted)}
        aria-pressed={muted}
        aria-label={actionLabel}
        title={actionLabel}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md transition-[background-color,color] duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
          muted
            ? 'text-amber-300/90 hover:bg-white/[0.08]'
            : 'text-rail-foreground/80 hover:bg-white/[0.08] hover:text-rail-active-foreground',
        )}
      >
        {muted ? <SoundOffIcon size={16} /> : <SoundOnIcon size={16} />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-rail-foreground/85">
      <span className={cn('shrink-0', muted ? 'text-amber-300/90' : 'text-rail-foreground/85')}>
        {muted ? <SoundOffIcon size={15} /> : <SoundOnIcon size={15} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">
        {t('sound.railLabel', { defaultValue: 'Message sounds' })}
      </span>
      <div
        role="group"
        aria-label={t('sound.railLabel', { defaultValue: 'Message sounds' })}
        className="inline-flex shrink-0 rounded-md bg-white/[0.07] p-0.5 text-[10px] font-semibold"
      >
        <button
          type="button"
          aria-pressed={!muted}
          onClick={() => setOn(true)}
          className={cn(
            'rounded px-1.5 py-0.5 transition-colors duration-fast ease-out',
            !muted
              ? 'bg-rail-active text-rail-active-foreground'
              : 'text-rail-foreground/55 hover:text-rail-foreground',
          )}
        >
          {t('sound.on', { defaultValue: 'On' })}
        </button>
        <button
          type="button"
          aria-pressed={muted}
          onClick={() => setOn(false)}
          className={cn(
            'rounded px-1.5 py-0.5 transition-colors duration-fast ease-out',
            muted
              ? 'bg-rail-active text-rail-active-foreground'
              : 'text-rail-foreground/55 hover:text-rail-foreground',
          )}
        >
          {t('sound.off', { defaultValue: 'Off' })}
        </button>
      </div>
    </div>
  );
}
