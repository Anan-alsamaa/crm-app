import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BellIcon, cn, formatRelative, Pill } from '@yiji/ui';
import { useNotifications, useMarkNotificationRead, type NotificationRow } from './api.js';

type NotifTone = 'destructive' | 'warning' | 'success' | 'primary' | 'muted' | 'pink';

const TONE_BY_TYPE: Record<string, NotifTone> = {
  sla_breach: 'destructive',
  sla_warning: 'warning',
  assignment: 'primary',
  mention: 'pink',
  ticket_update: 'primary',
  reminder: 'warning',
  escalation: 'destructive',
  automation: 'muted',
  // The one this bell was built for. Destructive rather than warning: it is
  // money leaving, and it should not read as the same weight as a timer.
  high_value_coupon: 'destructive',
};

/**
 * The admin bell.
 *
 * The admin portal had no notification surface at all — every alert the system
 * produced was addressed to agents, and an admin found out about things by
 * being on the right page. That is workable for a queue someone opens on a
 * schedule and not workable for a single coupon worth more than most orders,
 * which is what this exists to carry.
 *
 * Deliberately simpler than the agent bell: no socket (this portal has none —
 * see `useNotifications`), no grouping, no per-type filtering. Those earn their
 * complexity against a stream of assignments and mentions; here the list is
 * short and every row is worth reading.
 */
export function NotificationBell(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const markRead = useMarkNotificationRead();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState({ top: 0, right: 0 });

  /**
   * The panel MUST portal to <body>.
   *
   * The masthead is `backdrop-blur`, and backdrop-filter makes that header both
   * a containing block for fixed/absolute descendants and its own stacking
   * context — so a panel rendered inside it paints UNDER the page whatever its
   * z-index says. The agent portal hit exactly this. jsdom implements neither
   * backdrop-filter nor layout, so no unit test can catch a regression here:
   * keep the portal.
   */
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onReflow = () => place();
    // Capture, so scrolling ANY ancestor re-anchors the panel rather than
    // leaving it floating where the bell used to be.
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portalled, so it is NOT inside rootRef — testing only
      // rootRef would close it on every click on its own contents.
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const list = data ?? [];
  const unread = list.filter((n) => !n.read_at);

  const openNotification = (n: NotificationRow) => {
    if (!n.read_at) void markRead.mutateAsync(n.id).catch(() => null);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unread.length > 0
            ? t('notifications.openWithCount', {
                count: unread.length,
                defaultValue: `Notifications, ${unread.length} unread`,
              })
            : t('notifications.open', { defaultValue: 'Notifications' })
        }
        /* `text-current`, not a fixed foreground token: this sits on the dark
           ink masthead beside PageRefresh and LanguageToggle, which all inherit
           the surface colour the same way. A `text-foreground` here would be
           near-invisible on that bar. Sized h-7 to match them. */
        className={cn(
          'relative grid h-7 w-7 place-items-center rounded-md text-current/85',
          'transition-colors duration-fast ease-out hover:bg-current/10 hover:text-current',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        )}
      >
        <BellIcon />
        {unread.length > 0 && (
          <span
            // aria-hidden: the count is already in the accessible name above,
            // and announcing it twice reads as two separate controls.
            aria-hidden
            className="absolute -end-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground ring-2 ring-ink"
          >
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t('notifications.title', { defaultValue: 'Notifications' })}
            style={{ top: coords.top, right: coords.right }}
            className="fixed z-[60] w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <span className="text-sm font-semibold text-foreground">
                {t('notifications.title', { defaultValue: 'Notifications' })}
              </span>
              {unread.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    void Promise.all(
                      unread.map((n) => markRead.mutateAsync(n.id).catch(() => null)),
                    );
                  }}
                  className="rounded text-xs text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {t('notifications.markAllRead', { defaultValue: 'Mark all read' })}
                </button>
              )}
            </div>

            <div className="max-h-[min(28rem,60vh)] overflow-y-auto">
              {list.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {t('notifications.empty', { defaultValue: 'Nothing to read.' })}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {list.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => openNotification(n)}
                        className={cn(
                          'block w-full px-4 py-3 text-start transition-colors duration-fast ease-out',
                          'hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                          !n.read_at && 'bg-primary/[0.04]',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <Pill tone={TONE_BY_TYPE[n.type] ?? 'muted'} size="sm">
                            {n.type.replace(/_/g, ' ')}
                          </Pill>
                          {!n.read_at && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                              aria-label={t('notifications.unread', { defaultValue: 'Unread' })}
                            />
                          )}
                          <span className="ms-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
                            {n.date_created ? formatRelative(n.date_created) : ''}
                          </span>
                        </span>
                        <span className="mt-1.5 block text-xs font-medium text-foreground">
                          {n.title}
                        </span>
                        <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                          {n.body}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
