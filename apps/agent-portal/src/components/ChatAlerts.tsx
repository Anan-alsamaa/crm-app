import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import { Button, cn, InboxIcon } from '@yiji/ui';
import { SOCKET_EVENTS, displayContactName } from '@yiji/shared-types';
import { getSocket } from '../lib/socket.js';
import { directus } from '../lib/directus.js';
import { useAuth } from '../lib/auth/AuthContext.js';
import { askDesktopPermissionOnce, desktopPermission } from '../lib/chat-alerts.js';
import type { BusyState } from '../lib/job-producer.js';

/** Re-raise a still-unanswered chat's Windows notification once, after this. */
const REPEAT_MS = 60_000;
/** A banner on the inbox hides itself this long after the agent could see it. */
const BANNER_MS = 10_000;
/** At most this many banners stacked at once. */
const MAX_BANNERS = 3;

interface Alert {
  conversationId: string;
  name: string;
  preview: string;
  /** The chat belongs to nobody yet — a waiting customer, not one of mine. */
  waiting: boolean;
}

interface Tracked {
  notification?: Notification;
  repeat?: number;
}

/**
 * New-chat alerts — see lib/chat-alerts.ts for the why (owner, 2026-10-13).
 *
 * WHO is alerted: the agent the chat belongs to, or — while it belongs to
 * nobody — every agent who is not Busy. Never for every message in the team:
 * an alert that fires all day is an alert nobody reads. Directus decides what
 * this agent may read, so a chat outside their scope raises nothing.
 *
 * WHERE (owner, 2026-10-14):
 *  - the portal is NOT the window in front (another tab, another program,
 *    minimised): a Windows notification that stays until clicked, repeated
 *    once after a minute if still unanswered;
 *  - in the portal on any page but the INBOX: the centre card;
 *  - on the INBOX, working in a chat: a WhatsApp-style banner at the top that
 *    never blocks typing - the centre card there would interrupt a reply;
 *  - on the inbox with THAT chat open: nothing, the message is on screen.
 * What waits for the agent while they are away is shown the same way when
 * they come back. Opening the chat, or any agent replying, clears it all.
 */
export function ChatAlerts() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const tracked = useRef(new Map<string, Tracked>());
  const onInbox = location.pathname === '/';
  /* Windows' pop-up permission, asked on the first click (WeCare only). */
  useEffect(() => askDesktopPermissionOnce(), []);
  /* Is the portal the window in front? Banners only start their countdown
     once the agent can actually see them. */
  const [inFrontNow, setInFrontNow] = useState(
    () =>
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      document.hasFocus(),
  );
  useEffect(() => {
    const update = () =>
      setInFrontNow(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  /* Handlers live in a socket subscription made once; refs keep them reading
     the current user, route and query cache. */
  const userId = useRef(user?.id ?? null);
  userId.current = user?.id ?? null;
  const openConv = useRef<string | null>(null);
  openConv.current = new URLSearchParams(location.search).get('conv');

  const clear = useCallback((conversationId: string) => {
    const tr = tracked.current.get(conversationId);
    if (tr) {
      tr.notification?.close();
      if (tr.repeat) window.clearTimeout(tr.repeat);
      tracked.current.delete(conversationId);
    }
    setAlerts((list) => list.filter((a) => a.conversationId !== conversationId));
  }, []);

  const open = useCallback(
    (conversationId: string) => {
      clear(conversationId);
      navigate(`/?conv=${conversationId}`);
    },
    [clear, navigate],
  );
  const openRef = useRef(open);
  openRef.current = open;

  const dismissAll = useCallback(() => {
    for (const id of [...tracked.current.keys()]) clear(id);
    setAlerts([]);
  }, [clear]);

  // Opening the chat by any route is the answer to its alert.
  useEffect(() => {
    const id = openConv.current;
    // Unconditional: the tracking map resets when the subscription is remade.
    if (id) clear(id);
  }, [location.search, clear]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const inFront = () => document.visibilityState === 'visible' && document.hasFocus();

    const showDesktop = (a: Alert) => {
      if (desktopPermission() !== 'granted' || inFront()) return undefined;
      try {
        const n = new Notification(
          a.waiting
            ? t('chatAlerts.waitingTitle', {
                defaultValue: 'New chat waiting — {{name}}',
                name: a.name,
              })
            : t('chatAlerts.mineTitle', { defaultValue: 'New message — {{name}}', name: a.name }),
          {
            body: a.preview,
            tag: `chat-${a.conversationId}`,
            // Stays on screen until the agent acts — a 5-second toast is the
            // thing that goes unnoticed.
            requireInteraction: true,
            icon: '/sara-crm-icon.png',
          },
        );
        n.onclick = () => {
          window.focus();
          openRef.current(a.conversationId);
          n.close();
        };
        return n;
      } catch {
        return undefined;
      }
    };

    const stillUnanswered = async (conversationId: string) => {
      const rows = (await directus.request(
        readItems('messages', {
          filter: { conversation: { _eq: conversationId } },
          fields: ['sender_type'],
          sort: ['-date_created'],
          limit: 1,
        }),
      )) as Array<{ sender_type: string }>;
      return rows[0]?.sender_type === 'customer';
    };

    const raise = async (conversationId: string) => {
      const me = userId.current;
      if (!me) return;
      // Already looking at this very chat — nothing to tell them.
      if (openConv.current === conversationId && inFront()) return;

      const convs = (await directus.request(
        readItems('conversations', {
          filter: { id: { _eq: conversationId } },
          fields: ['id', 'status', 'assigned_agent', { contact: ['name', 'phone'] }],
          limit: 1,
        }),
      )) as Array<{
        id: string;
        status: string;
        assigned_agent: string | null;
        contact: { name: string | null; phone: string | null } | null;
      }>;
      const conv = convs[0];
      if (!conv || conv.status === 'solved') return;
      const mine = conv.assigned_agent === me;
      const waiting = !conv.assigned_agent;
      if (!mine && !waiting) return;
      // A Busy agent is taking no NEW chats; their own customers still reach them.
      if (waiting && qc.getQueryData<BusyState>(['my-busy'])?.busy) return;

      const last = (await directus.request(
        readItems('messages', {
          filter: {
            conversation: { _eq: conversationId },
            sender_type: { _eq: 'customer' },
          },
          fields: ['content'],
          sort: ['-date_created'],
          limit: 1,
        }),
      )) as Array<{ content: string | null }>;
      const text = (last[0]?.content ?? '').trim();
      const alert: Alert = {
        conversationId,
        name:
          displayContactName(conv.contact?.name, conv.contact?.phone) ||
          t('inbox.unknownContact', { defaultValue: 'Customer' }),
        preview: text
          ? text.length > 140
            ? `${text.slice(0, 140)}…`
            : text
          : t('chatAlerts.attachment', { defaultValue: 'Sent an attachment' }),
        waiting,
      };
      if (cancelled) return;

      setAlerts((list) => [alert, ...list.filter((a) => a.conversationId !== conversationId)]);
      const prev = tracked.current.get(conversationId);
      prev?.notification?.close();
      if (prev?.repeat) window.clearTimeout(prev.repeat);
      const entry: Tracked = { notification: showDesktop(alert) };
      // One reminder if nobody has answered a minute later.
      entry.repeat = window.setTimeout(() => {
        void stillUnanswered(conversationId)
          .then((open) => {
            const tr = tracked.current.get(conversationId);
            if (!open || !tr) return;
            tr.notification?.close();
            tr.notification = showDesktop(alert);
            tr.repeat = undefined;
          })
          .catch(() => undefined);
      }, REPEAT_MS);
      tracked.current.set(conversationId, entry);
    };

    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      const onActivity = (e?: {
        conversationId?: string;
        senderType?: string;
        silent?: boolean;
      }) => {
        if (!e?.conversationId || e.silent) return;
        // Somebody answered: the alert has done its job, on every screen.
        if (e.senderType === 'agent') {
          clear(e.conversationId);
          return;
        }
        if (e.senderType !== 'customer') return;
        void raise(e.conversationId).catch(() => undefined);
      };
      socket.on(SOCKET_EVENTS.inboxActivity, onActivity);
      cleanup = () => socket.off(SOCKET_EVENTS.inboxActivity, onActivity);
    })();

    const map = tracked.current;
    return () => {
      cancelled = true;
      cleanup?.();
      for (const tr of map.values()) {
        tr.notification?.close();
        if (tr.repeat) window.clearTimeout(tr.repeat);
      }
      map.clear();
    };
  }, [clear, qc, t]);

  useEffect(() => {
    if (alerts.length === 0 || onInbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [alerts.length, dismissAll, onInbox]);

  // Inbox banners hide themselves once seen for BANNER_MS.
  const bannerKey = onInbox && inFrontNow ? alerts.map((a) => a.conversationId).join(',') : '';
  useEffect(() => {
    if (!bannerKey) return;
    const timers = bannerKey
      .split(',')
      .map((id) => window.setTimeout(() => dismissBanner(id), BANNER_MS));
    return () => timers.forEach((x) => window.clearTimeout(x));
  }, [bannerKey]);
  /* Hides the banner only: the Windows reminder for an unanswered chat stays
     armed, because a banner nobody clicked is not an answer. */
  function dismissBanner(conversationId: string) {
    setAlerts((list) => list.filter((a) => a.conversationId !== conversationId));
  }

  const top = alerts[0];
  if (!top) return null;
  const more = alerts.length - 1;

  if (onInbox) {
    return (
      <div
        aria-live="polite"
        className="pointer-events-none fixed end-4 top-16 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {alerts.slice(0, MAX_BANNERS).map((a) => (
          <div
            key={a.conversationId}
            role="status"
            className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-card p-3 shadow-2xl ring-1 ring-foreground/10 motion-safe:animate-slide-down-and-fade"
          >
            <span className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <InboxIcon size={16} aria-hidden />
            </span>
            <button
              type="button"
              onClick={() => open(a.conversationId)}
              className="min-w-0 flex-1 text-start focus-visible:outline-none"
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{a.name}</span>
                <span className="shrink-0 text-2xs font-semibold uppercase tracking-[0.1em] text-primary">
                  {a.waiting
                    ? t('chatAlerts.waitingLabel', { defaultValue: 'New chat waiting' })
                    : t('chatAlerts.mineLabel', { defaultValue: 'New message' })}
                </span>
              </div>
              <p
                dir="auto"
                className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground"
              >
                {a.preview}
              </p>
            </button>
            <button
              type="button"
              onClick={() => dismissBanner(a.conversationId)}
              aria-label={t('chatAlerts.close', { defaultValue: 'Close' })}
              className="shrink-0 rounded px-1 text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
        ))}
        {alerts.length > MAX_BANNERS && (
          <p className="pointer-events-auto self-end rounded-full bg-card px-3 py-1 text-xs text-muted-foreground shadow ring-1 ring-foreground/10">
            {t('chatAlerts.more', {
              defaultValue: '+{{n}} more waiting',
              n: alerts.length - MAX_BANNERS,
            })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-foreground/15 p-4 backdrop-blur-[2px] motion-safe:animate-fade-in"
      onClick={dismissAll}
    >
      <div
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="chat-alert-title"
        aria-describedby="chat-alert-preview"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-card p-6 text-center shadow-2xl ring-1 ring-foreground/10 motion-safe:animate-scale-in"
      >
        <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center">
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-primary/30 motion-safe:animate-ping"
          />
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <InboxIcon size={24} aria-hidden />
          </span>
        </div>
        <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-primary">
          {top.waiting
            ? t('chatAlerts.waitingLabel', { defaultValue: 'New chat waiting' })
            : t('chatAlerts.mineLabel', { defaultValue: 'New message' })}
        </div>
        <h2 id="chat-alert-title" className="mt-1 truncate text-lg font-semibold text-foreground">
          {top.name}
        </h2>
        <p
          id="chat-alert-preview"
          dir="auto"
          className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground"
        >
          {top.preview}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button type="button" onClick={() => open(top.conversationId)}>
            {t('chatAlerts.open', { defaultValue: 'Open chat' })}
          </Button>
          <Button type="button" variant="ghost" onClick={dismissAll}>
            {t('chatAlerts.later', { defaultValue: 'Later' })}
          </Button>
        </div>
        {more > 0 && (
          <p className={cn('mt-3 text-xs text-muted-foreground')}>
            {t('chatAlerts.more', { defaultValue: '+{{n}} more waiting', n: more })}
          </p>
        )}
      </div>
    </div>
  );
}
