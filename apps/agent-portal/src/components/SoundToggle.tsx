import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SoundOffIcon, SoundOnIcon } from '@yiji/ui';
import { isSoundMuted, setSoundMuted } from '../lib/sound.js';

/** Rail control to mute/unmute the new-message notification beep. */
export function SoundToggle() {
  const { t } = useTranslation();
  const [muted, setMuted] = useState(isSoundMuted());
  const toggle = () => {
    const next = !muted;
    setSoundMuted(next);
    setMuted(next);
  };
  const label = muted
    ? t('sound.unmute', { defaultValue: 'Unmute notifications' })
    : t('sound.mute', { defaultValue: 'Mute notifications' });
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={muted}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-current/80 transition-[background-color,color] duration-fast ease-out hover:bg-current/10 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {muted ? <SoundOffIcon size={16} /> : <SoundOnIcon size={16} />}
    </button>
  );
}
