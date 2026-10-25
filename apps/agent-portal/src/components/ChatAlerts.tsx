import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { readItems } from '@directus/sdk';
import { Button, cn, InboxIcon } from '@yiji/ui';
import {
  SOCKET_EVENTS,
  displayContactName,
  type MessageDeleted,
  type MessageEdited,
} from '@yiji/shared-types';
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
  /** The customer message whose text this alert shows - edits follow it. */
  messageId: string | null;
  name: string;
  preview: string;
  /** The chat belongs to nobody yet — a waiting customer, not one of mine. */
  waiting: boolean;
}

interface Tracked {
  notification?: Notification;
  repeat?: number;
  /** What the notification (and the one-minute reminder) currently says. */
  alert: Alert;
}

/** The alert's one line of the customer's words. */
function previewText(content: string | null | undefined, attachment: string): string {
  const text = (content ?? '').trim();
  if (!text) return attachment;
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
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

    /**
     * `replace`: the SAME alert with new words (the customer edited the
     * message). The tag is per conversation, so the new notification takes the
     * old one's place; `renotify: false` + `silent` so it neither rings nor
     * pops again (owner, 2026-10-25). Shown even if the portal has come to the
     * front since: the old one was on screen, so its replacement must be.
     */
    const showDesktop = (a: Alert, replace = false) => {
      if (desktopPermission() !== 'granted' || (!replace && inFront())) return undefined;
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
            // `renotify` is not in every DOM lib yet; it is a standard option.
            ...(replace ? { renotify: false, silent: true } : {}),
          } as NotificationOptions,
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
            // A message the customer withdrew is not what they are waiting on.
            deleted_at: { _null: true },
          },
          fields: ['id', 'content'],
          sort: ['-date_created'],
          limit: 1,
        }),
      )) as Array<{ id?: string; content: string | null }>;
      const alert: Alert = {
        conversationId,
        messageId: last[0]?.id ?? null,
        name:
          displayContactName(conv.contact?.name, conv.contact?.phone) ||
          t('inbox.unknownContact', { defaultValue: 'Customer' }),
        preview: previewText(
          last[0]?.content,
          t('chatAlerts.attachment', { defaultValue: 'Sent an attachment' }),
        ),
        waiting,
      };
      if (cancelled) return;

      setAlerts((list) => [alert, ...list.filter((a) => a.conversationId !== conversationId)]);
      const prev = tracked.current.get(conversationId);
      prev?.notification?.close();
      if (prev?.repeat) window.clearTimeout(prev.repeat);
      const entry: Tracked = { notification: showDesktop(alert), alert };
      // One reminder if nobody has answered a minute later.
      entry.repeat = window.setTimeout(() => {
        void stillUnanswered(conversationId)
          .then((open) => {
            const tr = tracked.current.get(conversationId);
            if (!open || !tr) return;
            tr.notification?.close();
            // The words as they are NOW - an edit since must not be undone.
            tr.notification = showDesktop(tr.alert);
            tr.repeat = undefined;
          })
          .catch(() => undefined);
      }, REPEAT_MS);
      tracked.current.set(conversationId, entry);
    };

    /*
     * THE CUSTOMER EDITED OR WITHDREW THE MESSAGE AN ALERT SHOWS (owner,
     * 2026-10-25). Only that message, matched by id: an edit to an older one
     * changes nothing on screen.
     *  - edit: the Windows notification is replaced under the same tag,
     *    without a ring; the centre card / banner text changes in place;
     *  - delete: the alert is closed - there is nothing left to read.
     */
    const applyEdit = (conversationId: string, messageId: string, content: string) => {
      const tr = tracked.current.get(conversationId);
      const preview = previewText(
        content,
        t('chatAlerts.attachment', { defaultValue: 'Sent an attachment' }),
      );
      if (tr && tr.alert.messageId === messageId && tr.alert.preview !== preview) {
        tr.alert = { ...tr.alert, preview };
        if (tr.notification) {
          tr.notification.close();
          tr.notification = showDesktop(tr.alert, true);
        }
      }
      setAlerts((list) =>
        list.map((a) =>
          a.conversationId === conversationId && a.messageId === messageId && a.preview !== preview
            ? { ...a, preview }
            : a,
        ),
      );
    };
    const applyDelete = (conversationId: string, messageId: string) => {
      const tr = tracked.current.get(conversationId);
      const shown = tr?.alert.messageId === messageId;
      if (shown) {
        clear(conversationId);
        return;
      }
      setAlerts((list) =>
        list.filter((a) => !(a.conversationId === conversationId && a.messageId === messageId)),
      );
    };
    /*
     * The edit events go to the CONVERSATION room, which an agent is in for
     * their own chats but not for a waiting one; every agent does get the
     * silent inbox activity that follows an edit. So on that, an alert showing
     * a message re-reads it (one row, by id) and applies whatever changed.
     */
    const recheck = async (conversationId: string) => {
      const messageId = tracked.current.get(conversationId)?.alert.messageId;
      if (!messageId) return;
      const rows = (await directus.request(
        readItems('messages', {
          filter: { id: { _eq: messageId } },
          fields: ['id', 'content', 'deleted_at'],
          limit: 1,
        }),
      )) as Array<{ id?: string; content: string | null; deleted_at?: string | null }>;
      const row = rows[0];
      if (cancelled || !row) return;
      if (row.deleted_at) applyDelete(conversationId, messageId);
      else applyEdit(conversationId, messageId, row.content ?? '');
    };

    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      const onActivity = (e?: {
        conversationId?: string;
        senderType?: string;
        silent?: boolean;
      }) => {
        if (!e?.conversationId) return;
        if (e.silent) {
          // Nothing new arrived - but an alerted message may have changed.
          if (tracked.current.has(e.conversationId))
            void recheck(e.conversationId).catch(() => undefined);
          return;
        }
        // Somebody answered: the alert has done its job, on every screen.
        if (e.senderType === 'agent') {
          clear(e.conversationId);
          return;
        }
        if (e.senderType !== 'customer') return;
        void raise(e.conversationId).catch(() => undefined);
      };
      const onEdited = (e?: MessageEdited) => {
        if (e?.conversationId && e.messageId) applyEdit(e.conversationId, e.messageId, e.content);
      };
      const onDeleted = (e?: MessageDeleted) => {
        if (e?.conversationId && e.messageId) applyDelete(e.conversationId, e.messageId);
      };
      socket.on(SOCKET_EVENTS.inboxActivity, onActivity);
      socket.on(SOCKET_EVENTS.messageEdited, onEdited);
      socket.on(SOCKET_EVENTS.messageDeleted, onDeleted);
      cleanup = () => {
        socket.off(SOCKET_EVENTS.inboxActivity, onActivity);
        socket.off(SOCKET_EVENTS.messageEdited, onEdited);
        socket.off(SOCKET_EVENTS.messageDeleted, onDeleted);
      };
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
            className="pointer-events-auto flex items-start gap-3 rounded-[1.375rem] bg-card/95 p-3.5 backdrop-blur-xl shadow-[inset_0_0_0_1px_oklch(var(--foreground)/0.06),0_2px_6px_oklch(var(--shadow-color)/0.06),0_30px_60px_-32px_oklch(var(--shadow-color)/0.5)] motion-safe:animate-slide-down-and-fade"
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
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold text-primary">
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
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-base leading-none text-foreground/70 transition-colors duration-fast hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              ×
            </button>
          </div>
        ))}
        {alerts.length > MAX_BANNERS && (
          <p className="pointer-events-auto self-end rounded-full bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-[inset_0_0_0_1px_oklch(var(--foreground)/0.06),0_2px_6px_oklch(var(--shadow-color)/0.06),0_30px_60px_-32px_oklch(var(--shadow-color)/0.5)]">
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
        className="w-full max-w-sm rounded-[1.625rem] bg-card p-7 text-center shadow-[inset_0_0_0_1px_oklch(var(--foreground)/0.06),0_2px_6px_oklch(var(--shadow-color)/0.06),0_30px_60px_-32px_oklch(var(--shadow-color)/0.5)] motion-safe:animate-scale-in"
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
        <div className="mx-auto inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
          {top.waiting
            ? t('chatAlerts.waitingLabel', { defaultValue: 'New chat waiting' })
            : t('chatAlerts.mineLabel', { defaultValue: 'New message' })}
        </div>
        <h2
          id="chat-alert-title"
          className="mt-2.5 truncate text-xl font-semibold tracking-[-0.01em] text-foreground"
        >
          {top.name}
        </h2>
        <p
          id="chat-alert-preview"
          dir="auto"
          className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground"
        >
          {top.preview}
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button type="button" onClick={() => open(top.conversationId)}>
            {t('chatAlerts.open', { defaultValue: 'Open chat' })}
          </Button>
          {/* Soft secondary pill, explicit: this card may render outside the
              skin's dialog hooks. */}
          <button
            type="button"
            onClick={dismissAll}
            className="inline-flex h-10 items-center rounded-full bg-primary/10 px-5 text-sm font-semibold text-primary transition-colors duration-fast hover:bg-primary/[0.17] active:bg-primary/[0.24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {t('chatAlerts.later', { defaultValue: 'Later' })}
          </button>
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
