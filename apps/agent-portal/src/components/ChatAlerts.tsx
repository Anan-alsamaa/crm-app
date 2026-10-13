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
import { chatAlertsEnabled, desktopPermission } from '../lib/chat-alerts.js';
import type { BusyState } from '../lib/job-producer.js';

/** Re-raise a still-unanswered chat's Windows notification once, after this. */
const REPEAT_MS = 60_000;

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
 * WHERE: the centre card whenever the portal is open (it waits there if the
 * agent is away), plus a Windows notification while the portal is not the
 * window in front. Opening the chat, or any agent replying, clears both.
 */
export function ChatAlerts() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const tracked = useRef(new Map<string, Tracked>());

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
    if (id && tracked.current.has(id)) clear(id);
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
      if (!chatAlertsEnabled()) return;
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
          if (tracked.current.has(e.conversationId)) clear(e.conversationId);
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
    if (alerts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [alerts.length, dismissAll]);

  const top = alerts[0];
  if (!top) return null;
  const more = alerts.length - 1;

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
