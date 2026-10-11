import { useTranslation } from 'react-i18next';
import { cn } from '@yiji/ui';

/**
 * THE LIVE ORDERS SWITCH (owner, 2026-10-11).
 *
 * Live: a broadcast-style pill - outlined, a light-green "record" dot and LIVE.
 * Hovered while live it turns red and reads STOP, so the click it invites is
 * obvious. Not live: a plain, quiet "Go live". Short labels only; the tooltip
 * carries one line, not a paragraph.
 */
export function LiveToggle({
  live,
  onChange,
}: {
  live: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const liveLabel = t('lateOrders.live', { defaultValue: 'LIVE' });
  const stopLabel = t('lateOrders.stop', { defaultValue: 'STOP' });
  const goLabel = t('lateOrders.goLive', { defaultValue: 'Go live' });
  return (
    <button
      type="button"
      onClick={() => onChange(!live)}
      aria-pressed={live}
      aria-label={live ? stopLabel : goLabel}
      title={
        live
          ? t('lateOrders.liveTip', {
              defaultValue: 'Live: new late orders appear here. Click to stop.',
            })
          : t('lateOrders.goLiveTip', { defaultValue: 'Show late orders live, as they arrive.' })
      }
      className={cn(
        'group inline-flex h-9 min-w-[6.5rem] items-center justify-center gap-2 rounded-full px-4',
        'text-sm font-extrabold uppercase tracking-[0.12em] transition-colors duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        live
          ? 'border-2 border-foreground bg-card text-foreground hover:border-[#dc2626] hover:bg-[#dc2626] hover:text-white'
          : 'border border-foreground/20 bg-card font-semibold normal-case tracking-normal text-muted-foreground hover:border-foreground/40 hover:text-foreground',
      )}
    >
      {live ? (
        <>
          {/* The record dot: a light-green ring around a solid centre. */}
          <span
            aria-hidden
            className="relative inline-flex h-4 w-4 items-center justify-center rounded-full border-2 border-[#4ade80] group-hover:border-white"
          >
            <span className="h-2 w-2 rounded-full bg-[#4ade80] motion-safe:animate-pulse group-hover:bg-white" />
          </span>
          <span className="group-hover:hidden">{liveLabel}</span>
          <span className="hidden group-hover:inline">{stopLabel}</span>
        </>
      ) : (
        <>
          <span aria-hidden className="h-2.5 w-2.5 rounded-full border-2 border-current" />
          {goLabel}
        </>
      )}
    </button>
  );
}
