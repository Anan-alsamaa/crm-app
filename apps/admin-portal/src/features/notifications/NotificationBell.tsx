import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BellIcon, cn, formatRelative, Pill } from '@yiji/ui';
import { useNotifications, useMarkNotificationRead } from './api.js';

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
  access_change: 'destructive',
};

/**
 * The notification panel — the same one the agent portal has.
 *
 * This portal used to have its own, plainer list: no unread count, no
 * Unread/All split, no grouping by day, and no way to mark a single item read
 * without opening it. The owner asked for the agent portal's design here, and
 * the two are now the same component in everything but data source and the
 * footer: this portal has no preferences page, so there is no link to one.
 *
 * Two deliberate differences from the agent copy:
 *
 *   - No socket. The admin portal has no realtime client, so the list refreshes
 *     on a 30-second poll instead of on the gateway's push. It is a supervisor's
 *     bell, not a live inbox; thirty seconds is fine.
 *   - Portalled to <body>, for the same reason as the agent's: the top bar is
 *     `backdrop-blur`, which makes it a containing block and its own stacking
 *     context, so a panel rendered inside it cannot paint above the page.
 */
export function NotificationBell(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useNotifications();
  const markRead = useMarkNotificationRead();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; right: number }>({
    top: 0,
    left: 0,
    right: 0,
  });

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom, left: r.left, right: window.innerWidth - r.right });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onReflow = () => place();
    // `true` = capture, so scrolling any ancestor re-anchors the panel.
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, place]);

  // No realtime client in this portal — poll. See the note above.
  useEffect(() => {
    const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
    const poll = setInterval(refresh, 30_000);
    return () => clearInterval(poll);
  }, [qc]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portalled to <body>, so it is NOT inside rootRef — testing
      // only rootRef would treat every click on the panel's own content as an
      // outside click and close it before the click could land.
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
  const shown = filter === 'unread' ? unread : list;

  const markAllRead = async () => {
    await Promise.all(unread.map((n) => markRead.mutateAsync(n.id).catch(() => null)));
  };

  // Group by relative bucket (today / earlier).
  const groups = useMemo(() => {
    const today: typeof shown = [];
    const earlier: typeof shown = [];
    const now = Date.now();
    for (const n of shown) {
      const at = n.date_created ? new Date(n.date_created).getTime() : now;
      if ((now - at) / (1000 * 60 * 60 * 24) < 1) today.push(n);
      else earlier.push(n);
    }
    return { today, earlier };
  }, [shown]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground',
          'transition-[transform,background-color,color] duration-fast ease-out',
          'hover:bg-secondary hover:text-foreground active:scale-95',
        )}
        aria-label={t('notifications.title', { defaultValue: 'Notifications' })}
        aria-expanded={open}
      >
        <BellIcon size={17} />
        {unread.length > 0 && (
          <span
            className="absolute -end-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
            aria-label={`${unread.length} unread`}
          >
            {unread.length}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            // `fixed` + measured coords, since portalling to <body> removes the
            // bell as a positioning ancestor. Anchored on the INLINE-END edge so
            // it still hangs off the correct side of the bell under RTL (ar).
            style={{
              top: coords.top + 8,
              ...(document.documentElement.dir === 'rtl'
                ? { left: coords.left }
                : { right: coords.right }),
            }}
            className="fixed z-[60] w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in origin-top-end"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {t('notifications.title', { defaultValue: 'Notifications' })}
                </h2>
                <p className="text-2xs text-muted-foreground">
                  {unread.length === 0
                    ? t('notifications.allRead', { defaultValue: 'All caught up' })
                    : t('notifications.unreadCount', {
                        count: unread.length,
                        defaultValue: `${unread.length} unread`,
                      })}
                </p>
              </div>
              {unread.length > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="text-2xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  {t('notifications.markAllRead', { defaultValue: 'Mark all read' })}
                </button>
              )}
            </div>

            {/* Filter tabs */}
            <div className="flex gap-1 px-3 pb-2">
              {[
                {
                  id: 'unread' as const,
                  label: `${t('notifications.tabUnread', { defaultValue: 'Unread' })}${unread.length ? ` · ${unread.length}` : ''}`,
                },
                {
                  id: 'all' as const,
                  label: `${t('notifications.tabAll', { defaultValue: 'All' })}${list.length ? ` · ${list.length}` : ''}`,
                },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-fast ease-out',
                    filter === tab.id
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="max-h-[28rem] overflow-auto">
              {shown.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                  <span
                    aria-hidden
                    className="grid h-12 w-12 place-items-center rounded-full bg-primary-subtle text-primary"
                  >
                    <BellIcon size={22} />
                  </span>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">
                      {filter === 'unread'
                        ? t('notifications.allRead', { defaultValue: 'All caught up' })
                        : t('notifications.empty', { defaultValue: 'No notifications.' })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {filter === 'unread'
                        ? t('notifications.emptyHint', {
                            defaultValue: 'New SLA warnings, mentions, and assignments land here.',
                          })
                        : t('notifications.emptyAllHint', {
                            defaultValue: 'You have no notifications yet.',
                          })}
                    </p>
                  </div>
                </div>
              ) : (
                [
                  {
                    id: 'today',
                    heading: t('notifications.today', { defaultValue: 'Today' }),
                    items: groups.today,
                  },
                  {
                    id: 'earlier',
                    heading: t('notifications.earlier', { defaultValue: 'Earlier' }),
                    items: groups.earlier,
                  },
                ]
                  .filter((g) => g.items.length > 0)
                  .map((g) => (
                    <div key={g.id}>
                      <h3 className="px-5 pt-3 pb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {g.heading}
                      </h3>
                      <ul>
                        {g.items.map((n) => {
                          const tone = TONE_BY_TYPE[n.type] ?? 'muted';
                          return (
                            <li
                              key={n.id}
                              className={cn(
                                'group flex gap-3 px-5 py-3 transition-colors duration-fast ease-out hover:bg-secondary/50',
                                !n.read_at && 'bg-primary-subtle/30',
                              )}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  'mt-0.5 inline-flex h-2 w-2 shrink-0 items-center justify-center rounded-full',
                                  !n.read_at ? 'bg-primary' : 'bg-transparent',
                                )}
                              />
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="truncate text-sm font-semibold text-foreground">
                                    {n.title}
                                  </span>
                                  <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                                    {formatRelative(n.date_created)}
                                  </span>
                                </div>
                                <p className="text-xs text-muted-foreground line-clamp-2">
                                  {n.body}
                                </p>
                                <div className="flex items-center gap-2 pt-0.5">
                                  <Pill tone={tone} size="sm">
                                    {t(`notifications.type.${n.type}`, { defaultValue: n.type })}
                                  </Pill>
                                  {n.link && (
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        if (!n.read_at)
                                          await markRead.mutateAsync(n.id).catch(() => null);
                                        setOpen(false);
                                        if (n.link) navigate(n.link);
                                      }}
                                      className="text-2xs font-semibold text-primary underline-offset-2 hover:underline"
                                    >
                                      {t('notifications.view', { defaultValue: 'View' })}
                                    </button>
                                  )}
                                  {!n.read_at && (
                                    <button
                                      type="button"
                                      onClick={() => void markRead.mutateAsync(n.id)}
                                      className="ms-auto text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                    >
                                      {t('notifications.markRead', { defaultValue: 'Mark read' })}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
