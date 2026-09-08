import type { TFunction } from 'i18next';
import { cn } from '@yiji/ui';

/**
 * One counted tile in a list-panel header: a big number, a labelled dot, and a
 * click that filters the list to what it counts.
 *
 * Extracted from the inbox so the tickets panel can use the same control rather
 * than a near-copy. Two pages drifting apart is how "the same strip" ends up
 * with different disabled rules and different hover states, and this one
 * already encodes a lesson worth keeping (see `selectable`).
 */
export function QueueStat({
  label,
  value,
  tone,
  onClick,
  active = false,
  /**
   * Injected rather than imported: this lives outside any page, and passing
   * the caller's `t` keeps its namespaces and defaults intact.
   */
  t,
  /** How the tile explains itself. Filters that COMBINE and filters that
   *  REPLACE each other need different words, and a wrong tooltip is worse
   *  than none — see the tickets panel, where statuses are exclusive. */
  mode = 'additive',
}: {
  label: string;
  value: number;
  tone: 'default' | 'pink' | 'primary' | 'warning' | 'destructive';
  onClick?: () => void;
  active?: boolean;
  t: TFunction;
  mode?: 'additive' | 'exclusive';
}) {
  /*
   * A tile counting ZERO cannot usefully be clicked.
   *
   * Reported from staging: pressing UNREAD (showing 0) emptied the list, and
   * pressing OPEN afterwards left it empty — which reads as the buttons being
   * broken. They were not: nothing was unread, so `unread AND open` is
   * correctly the empty set. But an enabled control whose only possible
   * outcome is "nothing matches" is a trap, and the fix is to stop offering
   * the click rather than to explain the result afterwards.
   *
   * Disabled rather than hidden: the COUNT is still information worth showing
   * — "0 urgent" is a thing an agent wants to see — and a tile that vanishes
   * and reappears makes the strip jump.
   */
  const selectable = value > 0 || active;
  return (
    // Boxed mini-tile with a status dot by the label — the KPI grammar of the
    // reference boards, shrunk to the list header.
    <button
      type="button"
      onClick={selectable ? onClick : undefined}
      disabled={!selectable}
      className={cn(
        'flex flex-1 flex-col gap-0.5 rounded-xl bg-card px-2.5 py-2 text-start ring-1 ring-foreground/[0.06]',
        'transition-[background-color,box-shadow] duration-fast ease-out',
        selectable
          ? 'hover:bg-secondary/60 active:scale-[0.98]'
          : 'cursor-default opacity-55 hover:bg-card',
        active && 'bg-primary/[0.08] ring-primary/40',
      )}
      aria-pressed={onClick && selectable ? active : undefined}
      /*
       * Named by COUNT and label together — "23 open", not "open".
       *
       * The same statuses appear as chips in the page toolbar, so a bare
       * "open" leaves two controls sharing one name: a screen-reader user
       * hears the same thing twice with no way to tell which is the tile, and
       * a test cannot address either unambiguously. The number is the thing
       * this control adds, so it belongs in the name.
       */
      aria-label={`${value} ${label}`}
      title={
        !selectable
          ? t('inbox.noneToFilter', {
              label,
              defaultValue: 'No {{label}} chats to filter by',
            })
          : active
            ? t('inbox.clearFilter', { defaultValue: 'Click again to clear this filter' })
            : mode === 'exclusive'
              ? t('tickets.replaceFilter', { defaultValue: 'Shows only these' })
              : t('inbox.addFilter', {
                  defaultValue: 'Adds to the filters already applied',
                })
      }
    >
      <span
        className={cn(
          'text-lg font-extrabold tabular-nums tracking-[-0.03em]',
          tone === 'pink' && 'text-magenta',
          tone === 'primary' && 'text-primary',
          tone === 'warning' && 'text-warning-foreground',
          tone === 'destructive' && 'text-destructive',
          tone === 'default' && 'text-foreground',
        )}
      >
        {value}
      </span>
      <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            tone === 'pink' && 'bg-magenta',
            tone === 'primary' && 'bg-primary',
            tone === 'warning' && 'bg-warning',
            tone === 'destructive' && 'bg-destructive',
            tone === 'default' && 'bg-success',
          )}
        />
        <span className="truncate">{label}</span>
      </span>
    </button>
  );
}
