import { useEffect, useMemo, useRef, useState } from 'react';
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

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
      socket.on(SOCKET_EVENTS.notificationPushed, refresh);
      socket.on(SOCKET_EVENTS.inboxActivity, refresh);
      const poll = setInterval(refresh, 30_000);
      cleanup = () => {
        socket.off(SOCKET_EVENTS.notificationPushed, refresh);
        socket.off(SOCKET_EVENTS.inboxActivity, refresh);
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
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground',
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

      {open && (
        <div className="absolute end-0 top-full z-50 mt-2 w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in origin-top-end">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('notifications.title')}</h2>
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
                              <p className="text-xs text-muted-foreground line-clamp-2">{n.body}</p>
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

          {/* Footer */}
          <div className="bg-secondary/30 px-4 py-2.5 text-center text-2xs text-muted-foreground">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/preferences');
              }}
              className="hover:text-foreground"
            >
              {t('notifications.managePreferences', {
                defaultValue: 'Manage notification preferences',
              })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
