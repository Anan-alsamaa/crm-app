import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Socket } from 'socket.io-client';
import { connectWidget, type WidgetMessage } from './socket.js';
import { t, isRtl, type WidgetLocale } from './i18n.js';

export interface WidgetConfig {
  gatewayUrl: string;
  token: string;
  locale?: WidgetLocale;
  /**
   * Fallback contact details surfaced when no support agent is online.
   * Host pages can override per vendor; defaults match the Yiji CS desk.
   */
  fallback?: {
    phone?: string;
    email?: string;
  };
}

const DEFAULT_FALLBACK = {
  phone: '+966 55 598 0402',
  email: 'cs@anan.sa',
};

interface Branding {
  primary?: string;
  secondary?: string;
  accent?: string;
}

let msgSeq = 0;
const clientId = () => `c${Date.now()}_${msgSeq++}`;

/**
 * Surface gateway agent-presence to the host page via a window CustomEvent.
 * Host pages can subscribe with:
 *   window.addEventListener('yiji:agents-presence', (e) => e.detail.count)
 * to mirror live status in their own UI (e.g. a top-bar online/offline pill)
 * without having to talk to the gateway directly.
 */
function broadcastPresenceToHost(count: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('yiji:agents-presence', { detail: { count } }));
}

/* Inline icons — no library, no emoji. Keep the bundle small. */
function ChatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3.4 20.4 21 13c.6-.3.6-1.2 0-1.5L3.4 3.6c-.6-.3-1.3.3-1.1 1L4 11l9 1-9 1-1.7 6.4c-.2.7.5 1.3 1.1 1Z" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="m3 6 9 7 9-7" />
    </svg>
  );
}

/* Greeting illustration (in-bubble brand mark + dots). */
function EmptyArt() {
  return (
    <svg viewBox="0 0 120 120" fill="none" aria-hidden className="yiji-empty-illu">
      <circle cx="60" cy="60" r="50" fill="var(--yiji-primary)" fill-opacity="0.08" />
      <path
        d="M28 48a10 10 0 0 1 10-10h44a10 10 0 0 1 10 10v22a10 10 0 0 1-10 10H58l-12 10v-10h-8a10 10 0 0 1-10-10V48Z"
        fill="var(--yiji-primary)"
        fill-opacity="0.14"
        stroke="var(--yiji-primary)"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <circle cx="48" cy="60" r="2.5" fill="var(--yiji-primary)" />
      <circle cx="60" cy="60" r="2.5" fill="var(--yiji-primary)" />
      <circle cx="72" cy="60" r="2.5" fill="var(--yiji-primary)" />
      <circle cx="92" cy="32" r="4" fill="var(--yiji-secondary)" />
      <circle cx="22" cy="92" r="3" fill="var(--yiji-secondary)" fill-opacity="0.6" />
    </svg>
  );
}

export function Widget({ config }: { config: WidgetConfig }) {
  const locale: WidgetLocale = config.locale ?? 'en';
  const tr = t(locale);
  const rtl = isRtl(locale);

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'error'>(
    'connecting',
  );
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [branding, setBranding] = useState<Branding>({});
  const [ready, setReady] = useState(false);
  const [csat, setCsat] = useState<{ score: number; comment: string; submitted: boolean } | null>(
    null,
  );
  const [agentsOnline, setAgentsOnline] = useState<number>(0);
  const socketRef = useRef<Socket | null>(null);
  const convoRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signalTyping = () => {
    if (!convoRef.current || !socketRef.current) return;
    const convo = convoRef.current;
    if (!isTypingRef.current) {
      socketRef.current.emit('typing:start', { conversationId: convo });
      isTypingRef.current = true;
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit('typing:stop', { conversationId: convo });
      isTypingRef.current = false;
      typingTimeoutRef.current = null;
    }, 2000);
  };
  const stopTyping = () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (isTypingRef.current && convoRef.current && socketRef.current) {
      socketRef.current.emit('typing:stop', { conversationId: convoRef.current });
      isTypingRef.current = false;
    }
  };

  useEffect(() => {
    const socket = connectWidget(config.gatewayUrl, config.token, {
      onStatus: setStatus,
      onReady: ({ conversationId, branding: b, agentsOnline: count }) => {
        convoRef.current = conversationId;
        if (b && typeof b === 'object') setBranding(b as Branding);
        setAgentsOnline(count);
        setReady(true);
        broadcastPresenceToHost(count);
      },
      onAgentsPresence: (count) => {
        setAgentsOnline(count);
        broadcastPresenceToHost(count);
      },
      onMessage: (msg) => {
        setMessages((prev) => {
          if (msg.clientMsgId && prev.some((m) => m.clientMsgId === msg.clientMsgId)) {
            return prev.map((m) => (m.clientMsgId === msg.clientMsgId ? msg : m));
          }
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        if (msg.senderType !== 'customer' && !open) setUnread((u) => u + 1);
      },
      onTyping: setAgentTyping,
      onClosed: () => {
        // Open the panel + show CSAT — but only once per conversation.
        setOpen(true);
        setCsat((cur) => cur ?? { score: 0, comment: '', submitted: false });
      },
    });
    socketRef.current = socket;
    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, agentTyping]);

  // Focus the textarea when the panel opens so the customer can type immediately.
  useEffect(() => {
    if (open) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  const send = () => {
    const content = draft.trim();
    if (!content || !convoRef.current || !socketRef.current) return;
    const cmid = clientId();
    setMessages((prev) => [
      ...prev,
      {
        id: cmid,
        conversationId: convoRef.current!,
        senderType: 'customer',
        content,
        attachments: [],
        createdAt: new Date().toISOString(),
        clientMsgId: cmid,
      },
    ]);
    socketRef.current.emit('message:send', {
      conversationId: convoRef.current,
      content,
      clientMsgId: cmid,
    });
    setDraft('');
    stopTyping();
  };

  const onInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    const value = target.value;
    setDraft(value);
    if (value.trim().length === 0) stopTyping();
    else signalTyping();
    // Auto-grow.
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 90)}px`;
  };

  const cssVars = useMemo(
    () =>
      ({
        '--brand-primary': branding.primary ?? '#0f8d8f',
        '--brand-secondary': branding.secondary ?? '#ec4899',
        '--brand-accent': branding.accent ?? '#f59e0b',
      }) as Record<string, string>,
    [branding],
  );

  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      style={cssVars}
      className={`yiji-widget${open ? ' yiji-open' : ''}`}
    >
      {open && (
        <div className="yiji-panel" role="dialog" aria-label={tr.title}>
          <header className="yiji-header">
            <div className="yiji-header-row">
              <div className="yiji-header-text yiji-header-text-with-logo">
                <img
                  src="/yiji-logo.png"
                  alt="YIJI"
                  className="yiji-header-logo"
                  width={32}
                  height={32}
                  draggable={false}
                />
                <div>
                  <p className="yiji-header-greeting">{tr.greeting}</p>
                  <p className="yiji-header-sub">{tr.subtitle}</p>
                </div>
              </div>
              <button className="yiji-close" onClick={() => setOpen(false)} aria-label={tr.close}>
                <CloseIcon />
              </button>
            </div>
            <div className="yiji-header-team">
              <div className="yiji-header-team-avatars">
                <span
                  className="yiji-header-team-avatar"
                  style={{ background: 'oklch(0.78 0.10 200)' }}
                >
                  YJ
                </span>
                <span
                  className="yiji-header-team-avatar"
                  style={{ background: 'oklch(0.78 0.10 50)' }}
                >
                  SU
                </span>
                <span
                  className="yiji-header-team-avatar"
                  style={{ background: 'oklch(0.78 0.10 300)' }}
                >
                  +
                </span>
              </div>
              <span className={`yiji-header-status${agentsOnline === 0 ? ' offline' : ''}`}>
                {agentsOnline === 0 ? tr.offlineTitle : tr.online}
              </span>
            </div>
          </header>

          {(!ready || status !== 'connected') && (
            <div className="yiji-status" data-testid="yiji-status">
              {status === 'reconnecting' ? tr.reconnecting : tr.connecting}
            </div>
          )}

          <div className="yiji-messages" ref={listRef}>
            {messages.length === 0 && ready ? (
              <div className="yiji-empty">
                <EmptyArt />
                <h3 className="yiji-empty-title">{tr.emptyTitle}</h3>
                <p className="yiji-empty-sub">{tr.emptySub}</p>
              </div>
            ) : (
              <>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`yiji-msg ${m.senderType === 'customer' ? 'mine' : 'theirs'}`}
                  >
                    {m.content}
                  </div>
                ))}
                {agentTyping && (
                  <div className="yiji-typing" aria-label={tr.typing}>
                    <span className="yiji-typing-dot" />
                    <span className="yiji-typing-dot" />
                    <span className="yiji-typing-dot" />
                  </div>
                )}
              </>
            )}
          </div>

          {csat ? (
            <div className="yiji-csat">
              {csat.submitted ? (
                <>
                  <p className="yiji-csat-title">{tr.csatThanks}</p>
                  <p className="yiji-csat-sub">{tr.csatThanksSub}</p>
                </>
              ) : (
                <>
                  <p className="yiji-csat-title">{tr.csatTitle}</p>
                  <p className="yiji-csat-sub">{tr.csatSub}</p>
                  <div className="yiji-csat-stars" role="radiogroup" aria-label={tr.csatTitle}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={csat.score === n}
                        className={`yiji-csat-star ${n <= csat.score ? 'filled' : ''}`}
                        onClick={() => setCsat({ ...csat, score: n })}
                        aria-label={`${n}`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="yiji-csat-comment"
                    placeholder={tr.csatCommentPlaceholder}
                    value={csat.comment}
                    onInput={(e) =>
                      setCsat({ ...csat, comment: (e.target as HTMLTextAreaElement).value })
                    }
                    rows={2}
                  />
                  <button
                    type="button"
                    className="yiji-csat-submit"
                    disabled={csat.score === 0}
                    onClick={() => {
                      if (!convoRef.current || !socketRef.current) return;
                      socketRef.current.emit('csat:submit', {
                        conversationId: convoRef.current,
                        score: csat.score,
                        comment: csat.comment,
                      });
                      setCsat({ ...csat, submitted: true });
                    }}
                  >
                    {tr.csatSubmit}
                  </button>
                </>
              )}
            </div>
          ) : ready && agentsOnline === 0 ? (
            <div className="yiji-offline" role="region" aria-label={tr.offlineTitle}>
              <p className="yiji-offline-title">{tr.offlineTitle}</p>
              <p className="yiji-offline-body">{tr.offlineBody}</p>
              <div className="yiji-offline-actions">
                <a
                  href={`tel:${(config.fallback?.phone ?? DEFAULT_FALLBACK.phone).replace(/\s+/g, '')}`}
                  className="yiji-offline-link"
                >
                  <span className="yiji-offline-link-icon" aria-hidden>
                    <PhoneIcon />
                  </span>
                  <span className="yiji-offline-link-text">
                    <span className="yiji-offline-link-label">{tr.offlineCallLabel}</span>
                    <span className="yiji-offline-link-value">
                      {config.fallback?.phone ?? DEFAULT_FALLBACK.phone}
                    </span>
                  </span>
                </a>
                <a
                  href={`mailto:${config.fallback?.email ?? DEFAULT_FALLBACK.email}`}
                  className="yiji-offline-link"
                >
                  <span className="yiji-offline-link-icon" aria-hidden>
                    <MailIcon />
                  </span>
                  <span className="yiji-offline-link-text">
                    <span className="yiji-offline-link-label">{tr.offlineEmailLabel}</span>
                    <span className="yiji-offline-link-value">
                      {config.fallback?.email ?? DEFAULT_FALLBACK.email}
                    </span>
                  </span>
                </a>
              </div>
            </div>
          ) : (
            <div className="yiji-input">
              <textarea
                ref={textareaRef}
                value={draft}
                placeholder={tr.placeholder}
                onInput={onInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
              />
              <button
                className="yiji-send"
                onClick={send}
                aria-label={tr.send}
                disabled={!ready || draft.trim().length === 0}
              >
                <SendIcon />
              </button>
            </div>
          )}

          <p className="yiji-footer">
            <strong>{tr.poweredBy}</strong>
          </p>
        </div>
      )}
      <button className="yiji-launcher" onClick={() => setOpen((o) => !o)} aria-label={tr.title}>
        <ChatIcon />
        {unread > 0 && <span className="yiji-badge">{unread}</span>}
      </button>
    </div>
  );
}
