import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BellIcon, cn, formatRelative, Pill } from '@yiji/ui';
import { SOCKET_EVENTS } from '@yiji/shared-types';
import { useNotifications, useMarkNotificationRead } from './api.js';
import { getSocket } from '../../lib/socket.js';

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

export function NotificationBell() {
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

  /**
   * Anchor the portalled panel to the bell.
   *
   * The panel MUST portal to <body>: the AppShell top bar is `backdrop-blur`,
   * and backdrop-filter makes that header a containing block for fixed/absolute
   * descendants AND its own stacking context — so a panel rendered inside it
   * cannot paint above page content no matter how high its z-index is. That is
   * why this dropdown appeared *underneath* the page. Same reason the palette,
   * dialogs, drawer and select menus already portal.
   *
   * jsdom implements neither backdrop-filter nor layout, so no unit test can
   * catch a regression here — keep the portal.
   */
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

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
      socket.on(SOCKET_EVENTS.notificationPushed, refresh);
      socket.on(SOCKET_EVENTS.inboxActivity, refresh);
      /* A dropped socket misses every push while it is down. The 30s poll below
         would catch up eventually; refreshing on reconnect makes it immediate,
         which matters when the drop was a gateway deploy and an assignment
         landed during it. See the fuller note in Inbox.tsx. */
      socket.on('connect', refresh);
      const poll = setInterval(refresh, 30_000);
      cleanup = () => {
        socket.off(SOCKET_EVENTS.notificationPushed, refresh);
        socket.off(SOCKET_EVENTS.inboxActivity, refresh);
        socket.off('connect', refresh);
        clearInterval(poll);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [qc]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portalled to <body>, so it is NOT inside rootRef any more —
      // testing only rootRef would treat every click on the panel's own content
      // as an outside click and close it before the click could land.
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

  // Group notifications by relative bucket (today / earlier).
  const groups = useMemo(() => {
    const today: typeof shown = [];
    const earlier: typeof shown = [];
    const now = Date.now();
    for (const n of shown) {
      const t = n.date_created ? new Date(n.date_created).getTime() : now;
      const dayDiff = (now - t) / (1000 * 60 * 60 * 24);
      if (dayDiff < 1) today.push(n);
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
          'relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground',
          'transition-[transform,background-color,color] duration-fast ease-out',
          'hover:bg-secondary hover:text-foreground active:scale-95',
        )}
        aria-label={t('notifications.title')}
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
            /* The frosted float card of the portal's dialogs: the 26px corner,
               one hairline, the long soft drop. */
            className="fixed z-[60] w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-[1.625rem] bg-popover/95 text-popover-foreground backdrop-blur-xl animate-scale-in origin-top-end shadow-[inset_0_0_0_1px_oklch(var(--foreground)/0.06),0_2px_6px_oklch(var(--shadow-color)/0.06),0_30px_60px_-32px_oklch(var(--shadow-color)/0.45)]"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-5">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold leading-tight tracking-[-0.01em] text-foreground">
                  {t('notifications.title')}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
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
                  className="inline-flex items-center rounded-full bg-primary/10 px-3 font-semibold text-primary transition-colors duration-fast ease-out hover:bg-primary/[0.17] active:bg-primary/[0.24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 h-8 shrink-0 text-xs"
                >
                  {t('notifications.markAllRead', { defaultValue: 'Mark all read' })}
                </button>
              )}
            </div>

            {/* Filter tabs */}
            {/* The composer's segmented pill: one track, the chosen tab lifted. */}
            <div className="mx-5 mb-2 flex rounded-full bg-secondary/80 p-0.5 ring-1 ring-inset ring-foreground/[0.06]">
              {[
                {
                  id: 'unread' as const,
                  label: `${t('notifications.tabUnread')}${unread.length ? ` · ${unread.length}` : ''}`,
                },
                {
                  id: 'all' as const,
                  label: `${t('notifications.tabAll')}${list.length ? ` · ${list.length}` : ''}`,
                },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={cn(
                    'inline-flex h-7 flex-1 items-center justify-center rounded-full px-3 text-xs font-semibold transition-[background-color,color,box-shadow] duration-fast ease-out',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    filter === tab.id
                      ? 'bg-card text-foreground shadow-[0_2px_8px_-4px_oklch(var(--shadow-color)/0.5)]'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="max-h-[28rem] overflow-auto pb-2">
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
                        : t('notifications.empty')}
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
                      <h3 className="px-5 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
                        {g.heading}
                      </h3>
                      <ul>
                        {g.items.map((n) => {
                          const tone = TONE_BY_TYPE[n.type] ?? 'muted';
                          return (
                            <li
                              key={n.id}
                              className={cn(
                                'group mx-2 flex gap-3 rounded-2xl px-3 py-3 transition-colors duration-fast ease-out hover:bg-secondary/60',
                                !n.read_at && 'bg-primary/[0.04]',
                              )}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  'mt-1.5 inline-flex h-2 w-2 shrink-0 items-center justify-center rounded-full',
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
                                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                  {n.body}
                                </p>
                                <div className="flex items-center gap-2 pt-1">
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
                                      className="inline-flex items-center rounded-full bg-primary/10 px-3 font-semibold text-primary transition-colors duration-fast ease-out hover:bg-primary/[0.17] active:bg-primary/[0.24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 h-7 text-xs"
                                    >
                                      {t('notifications.view', { defaultValue: 'View' })}
                                    </button>
                                  )}
                                  {!n.read_at && (
                                    <button
                                      type="button"
                                      onClick={() => void markRead.mutateAsync(n.id)}
                                      className="ms-auto inline-flex h-7 items-center rounded-full bg-foreground/[0.05] px-2.5 text-xs font-medium text-foreground/75 transition-colors duration-fast hover:bg-foreground/[0.09] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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

            {/* Footer */}
            <div className="flex justify-center px-4 py-3 shadow-[inset_0_1px_0_oklch(var(--foreground)/0.065)]">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/preferences');
                }}
                className="inline-flex items-center rounded-full bg-primary/10 px-3 font-semibold text-primary transition-colors duration-fast ease-out hover:bg-primary/[0.17] active:bg-primary/[0.24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 h-8 text-xs"
              >
                {t('notifications.managePreferences', {
                  defaultValue: 'Manage notification preferences',
                })}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
