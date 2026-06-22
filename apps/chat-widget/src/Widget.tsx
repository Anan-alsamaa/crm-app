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

// An attachment is an image if its MIME says so, OR (when the MIME is missing)
// its filename has an image extension — otherwise a null-type PNG would render
// as a download chip instead of an inline thumbnail.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic|ico)$/i;
function looksLikeImage(type?: string | null, name?: string | null): boolean {
  if ((type ?? '').toLowerCase().startsWith('image/')) return true;
  if (type) return false;
  return !!name && IMAGE_EXT.test(name);
}

// Whether to render an attachment inline as an image (thumbnail + lightbox).
// True when the MIME says image, the filename looks like an image, OR we have
// the bytes but no type/extension hint at all (realtime files arrive as bare
// ids). In the last case the <img> decode is the real test — a genuine
// non-image falls back to a download chip via onError — so an inbound image is
// never shown as a download link first.
function maybeImage(type?: string | null, name?: string | null): boolean {
  if (looksLikeImage(type, name)) return true;
  if (type) return false; // explicit non-image MIME
  if (!name) return true; // bytes, no type, no name → let the decode decide
  return !/\.[a-z0-9]{1,5}$/i.test(name); // a non-image extension → treat as a file
}

interface Branding {
  primary?: string;
  secondary?: string;
  accent?: string;
}

let msgSeq = 0;
const clientId = () => `c${Date.now()}_${msgSeq++}`;

// Stable id for the synthetic returning-customer greeting bubble, so it's
// deduped (never added twice) and can be styled distinctly in the thread.
const GREETING_ID = '__yiji_welcome__';

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

function AttachIcon() {
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
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
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

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.47 14.38c-.3-.15-1.74-.86-2-.96-.27-.1-.46-.15-.66.15-.2.29-.76.95-.93 1.15-.17.2-.34.22-.64.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.13.3-.34.45-.51.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.66-1.6-.91-2.19-.24-.57-.48-.49-.66-.5h-.56c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.87 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.08 1.74-.71 1.99-1.4.25-.69.25-1.28.17-1.4-.07-.13-.27-.2-.56-.35zM12.04 2.5C6.79 2.5 2.54 6.75 2.54 12c0 1.67.44 3.3 1.27 4.74L2.5 21.5l4.9-1.28a9.46 9.46 0 0 0 4.63 1.2h.01c5.24 0 9.5-4.26 9.5-9.5 0-2.54-.99-4.92-2.78-6.71A9.44 9.44 0 0 0 12.04 2.5z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10" />
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
  // The customer's own identity from the gateway `ready` event: a returning
  // customer (isNew === false) with a name on file gets greeted by name.
  const [customer, setCustomer] = useState<{ name: string | null; isNew: boolean }>({
    name: null,
    isNew: true,
  });
  const [csat, setCsat] = useState<{ score: number; comment: string; submitted: boolean } | null>(
    null,
  );
  const [agentsOnline, setAgentsOnline] = useState<number>(0);
  const [pending, setPending] = useState<
    Array<{ id: string; name: string; type: string; preview?: string }>
  >([]);
  const [uploading, setUploading] = useState(false);
  // Open image preview (same-page lightbox), and per-id <img> decode failures so
  // an optimistically-previewed non-image degrades to a download chip.
  const [lightbox, setLightbox] = useState<{ url: string; name: string | null } | null>(null);
  const [imgError, setImgError] = useState<Record<string, boolean>>({});
  // Resolved blob URLs for RECEIVED attachments (agent-sent, or own files after
  // a reload) — the customer has no Directus token, so the gateway streams the
  // bytes over the socket via attachment:get and we wrap them in a blob URL.
  const [resolved, setResolved] = useState<
    Record<string, { url?: string; type?: string | null; name?: string | null; error?: boolean }>
  >({});
  // Ids we've already requested, so a re-render never double-fetches.
  const attemptedRef = useRef<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  // Live mirror of `open` for the mount-time socket handlers, which otherwise
  // capture a stale `open` and would count messages read while open as unread.
  const openRef = useRef(open);
  const convoRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Remembers metadata for the customer's OWN uploads by file id, so their sent
  // bubbles can show the filename and an inline image preview (a local object
  // URL — the customer has no Directus token to refetch the file). Received
  // agent files arrive as bare ids with no metadata, so they fall back to a
  // generic "Attachment" chip.
  const attachMetaRef = useRef<Record<string, { name: string; type: string; preview?: string }>>(
    {},
  );
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
      onReady: ({ conversationId, branding: b, agentsOnline: count, contact, isNew }) => {
        convoRef.current = conversationId;
        if (b && typeof b === 'object') setBranding(b as Branding);
        setAgentsOnline(count);
        setCustomer({ name: contact?.name ?? null, isNew: isNew ?? true });
        setReady(true);
        broadcastPresenceToHost(count);
        // Drop a greeting into the thread as a real message — personalized for a
        // returning customer, generic ("Hey there…") for a new one. onReady fires
        // before messages:history, and onHistory prepends history
        // (`[...history, ...prev]`), so the greeting lands AFTER the loaded
        // history — and any message sent afterwards appends below it (pushing the
        // greeting up), instead of being stuck at the bottom.
        const name = contact?.name?.trim();
        const greeting =
          !(isNew ?? true) && name ? tr.welcomeNamed.replace('{name}', name) : tr.welcomeNew;
        setMessages((prev) => {
          if (prev.some((m) => m.id === GREETING_ID)) return prev;
          return [
            ...prev,
            {
              id: GREETING_ID,
              conversationId,
              senderType: 'agent',
              content: greeting,
              attachments: [],
              createdAt: new Date().toISOString(),
            },
          ];
        });
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
        if (msg.senderType !== 'customer' && !openRef.current) setUnread((u) => u + 1);
      },
      onHistory: (history) => {
        // Seed the existing thread on (re)connect. Keep any optimistic/live
        // message that isn't already part of the loaded history (dedupe by id).
        setMessages((prev) => {
          const seen = new Set(history.map((m) => m.id));
          return [...history, ...prev.filter((m) => !seen.has(m.id))];
        });
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
    openRef.current = open;
    if (open) setUnread(0);
  }, [open]);

  // Keep the thread pinned to the latest message. Also runs on `open` and when
  // attachments resolve (`resolved`): on first open the list mounts AFTER the
  // history is already in state, and images load async — without re-scrolling
  // after layout the panel would open stuck at the top instead of where the
  // conversation left off. Double rAF so we measure scrollHeight post-layout.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight });
      }),
    );
  }, [messages, agentTyping, open, resolved]);

  // Focus the textarea when the panel opens so the customer can type immediately.
  useEffect(() => {
    if (open) requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  // Dismiss the image lightbox on Escape (capture phase, so nothing downstream
  // swallows it) and lock background scroll while it's open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setLightbox(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [lightbox]);

  const send = () => {
    const content = draft.trim();
    const attachmentIds = pending.map((p) => p.id);
    if ((!content && attachmentIds.length === 0) || !convoRef.current || !socketRef.current) return;
    const cmid = clientId();
    setMessages((prev) => [
      ...prev,
      {
        id: cmid,
        conversationId: convoRef.current!,
        senderType: 'customer',
        content,
        attachments: attachmentIds,
        createdAt: new Date().toISOString(),
        clientMsgId: cmid,
      },
    ]);
    socketRef.current.emit('message:send', {
      conversationId: convoRef.current,
      content,
      ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      clientMsgId: cmid,
    });
    setDraft('');
    setPending([]);
    stopTyping();
  };

  // Upload through the gateway (it proxies to Directus; the customer has no
  // Directus account). Returns the file id to reference in message:send.
  const uploadOne = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = socketRef.current;
      if (!socket) return reject(new Error('not_connected'));
      void file.arrayBuffer().then((content) => {
        socket
          .timeout(20_000)
          .emit(
            'attachment:upload',
            { filename: file.name, mimetype: file.type, content },
            (err: Error | null, res?: { ok?: boolean; id?: string; error?: string }) => {
              if (err) return reject(new Error('timeout'));
              if (res?.ok && res.id) resolve(res.id);
              else reject(new Error(res?.error ?? 'upload_failed'));
            },
          );
      });
    });

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const id = await uploadOne(file);
        // Local object URL → instant image thumbnail in the composer and in the
        // sent bubble, with no need to refetch a private file the customer
        // can't access anyway.
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        attachMetaRef.current[id] = { name: file.name, type: file.type, preview };
        setPending((prev) => [...prev, { id, name: file.name, type: file.type, preview }]);
      }
    } catch {
      // Surface inline by appending a system note; keeps the widget dependency-free.
      setMessages((prev) => [
        ...prev,
        {
          id: clientId(),
          conversationId: convoRef.current ?? '',
          senderType: 'system',
          content: tr.attachFailed,
          attachments: [],
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const removePending = (id: string) =>
    setPending((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      delete attachMetaRef.current[id];
      return prev.filter((p) => p.id !== id);
    });

  // Fetch a received attachment's bytes through the gateway (once per id) and
  // expose a blob URL the bubble can render/download. Own image uploads already
  // have a local preview, so they're skipped.
  const ensureAttachment = (id: string) => {
    if (attachMetaRef.current[id]?.preview) return;
    if (attemptedRef.current.has(id)) return;
    const socket = socketRef.current;
    if (!socket) return;
    attemptedRef.current.add(id);
    socket.timeout(20_000).emit(
      'attachment:get',
      { id },
      (
        err: Error | null,
        res?: {
          ok?: boolean;
          content?: string; // base64
          type?: string | null;
          filename?: string | null;
        },
      ) => {
        if (err || !res?.ok || typeof res.content !== 'string') {
          setResolved((prev) => ({ ...prev, [id]: { error: true } }));
          return;
        }
        // content is base64 (see the gateway's attachment:get) — decode to bytes.
        const bin = atob(res.content);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(
          new Blob([bytes], { type: res.type ?? 'application/octet-stream' }),
        );
        setResolved((prev) => ({ ...prev, [id]: { url, type: res.type, name: res.filename } }));
      },
    );
  };

  // Resolve every attachment that appears in the thread (realtime + history).
  useEffect(() => {
    for (const m of messages) for (const id of m.attachments ?? []) ensureAttachment(id);
  }, [messages]);

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

  // A returning customer (known contact, not their first-ever connect) gets a
  // personalized greeting — in the header AND as the first chat bubble.
  const returningName = !customer.isNew && customer.name?.trim() ? customer.name.trim() : null;

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
                  <p className="yiji-header-greeting">
                    {!customer.isNew && customer.name?.trim()
                      ? tr.greetingNamed.replace('{name}', customer.name.trim())
                      : tr.greeting}
                  </p>
                  <p className="yiji-header-sub">{tr.subtitle}</p>
                </div>
              </div>
              <button className="yiji-close" onClick={() => setOpen(false)} aria-label={tr.close}>
                <CloseIcon />
              </button>
            </div>
            <div className="yiji-header-team">
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
            {messages.length === 0 && ready && !returningName ? (
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
                    className={`yiji-msg ${
                      m.senderType === 'customer'
                        ? 'mine'
                        : m.senderType === 'system'
                          ? 'system'
                          : 'theirs'
                    }${
                      !m.content?.trim() && m.attachments && m.attachments.length > 0 ? ' bare' : ''
                    }${m.id === GREETING_ID ? ' yiji-msg-greeting' : ''}`}
                  >
                    {m.content}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="yiji-msg-files">
                        {m.attachments.map((id) => {
                          const meta = attachMetaRef.current[id];
                          const r = resolved[id];
                          const url = meta?.preview ?? r?.url;
                          const type = meta?.type ?? r?.type ?? null;
                          const name = meta?.name ?? r?.name ?? null;
                          const showImage = !!url && maybeImage(type, name) && !imgError[id];
                          // Image (own preview or fetched): thumbnail, click opens
                          // the same-page lightbox (no new tab).
                          if (showImage) {
                            return (
                              <button
                                type="button"
                                className="yiji-msg-image"
                                key={id}
                                onClick={() => setLightbox({ url: url!, name })}
                                aria-label={name ?? tr.attachment}
                              >
                                <img
                                  src={url}
                                  alt={name ?? ''}
                                  onError={() => setImgError((e) => ({ ...e, [id]: true }))}
                                />
                              </button>
                            );
                          }
                          // Non-image (or undecodable) file with bytes available:
                          // download in place. No target=_blank — the `download`
                          // attribute saves the file without opening a new tab.
                          if (url) {
                            return (
                              <a
                                className="yiji-msg-file yiji-msg-file-link"
                                key={id}
                                href={url}
                                download={name ?? 'attachment'}
                              >
                                <AttachIcon />
                                <span>{name ?? tr.attachment}</span>
                              </a>
                            );
                          }
                          // Still fetching, or failed: a plain chip (with name when known).
                          return (
                            <span
                              className={`yiji-msg-file${r?.error ? '' : ' yiji-msg-file-loading'}`}
                              key={id}
                            >
                              <AttachIcon />
                              <span>{name ?? tr.attachment}</span>
                            </span>
                          );
                        })}
                      </div>
                    )}
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
                  href={`https://wa.me/${(config.fallback?.phone ?? DEFAULT_FALLBACK.phone).replace(/\D/g, '')}`}
                  className="yiji-offline-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span className="yiji-offline-link-icon" aria-hidden>
                    <WhatsAppIcon />
                  </span>
                  <span className="yiji-offline-link-text">
                    <span className="yiji-offline-link-label">{tr.offlineWhatsappLabel}</span>
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
            <>
              {pending.length > 0 && (
                <div className="yiji-pending">
                  {pending.map((p) => (
                    <span
                      className={`yiji-chip${p.preview ? ' yiji-chip-img' : ''}`}
                      key={p.id}
                      title={p.name}
                    >
                      {p.preview ? (
                        <img className="yiji-chip-thumb" src={p.preview} alt={p.name} />
                      ) : (
                        <>
                          <AttachIcon />
                          <span className="yiji-chip-name">{p.name}</span>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => removePending(p.id)}
                        aria-label={tr.removeAttachment}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="yiji-input">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => void onPickFiles((e.target as HTMLInputElement).files)}
                />
                <div className="yiji-field">
                  <button
                    className="yiji-attach"
                    onClick={() => fileRef.current?.click()}
                    aria-label={tr.attach}
                    disabled={!ready || uploading}
                  >
                    <AttachIcon />
                  </button>
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
                </div>
                <button
                  className="yiji-send"
                  onClick={send}
                  aria-label={tr.send}
                  disabled={!ready || (draft.trim().length === 0 && pending.length === 0)}
                >
                  <SendIcon />
                </button>
              </div>
            </>
          )}

          <p className="yiji-footer">
            <strong>{tr.poweredBy}</strong>
          </p>
        </div>
      )}
      {lightbox && (
        <div
          className="yiji-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.name ?? tr.attachment}
          onClick={() => setLightbox(null)}
        >
          <div className="yiji-lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span className="yiji-lightbox-name">{lightbox.name ?? tr.attachment}</span>
            <a
              className="yiji-lightbox-btn"
              href={lightbox.url}
              download={lightbox.name ?? 'image'}
              aria-label={tr.download}
            >
              <DownloadIcon />
            </a>
            <button
              type="button"
              className="yiji-lightbox-btn"
              onClick={() => setLightbox(null)}
              aria-label={tr.close}
            >
              <CloseIcon />
            </button>
          </div>
          <img
            className="yiji-lightbox-img"
            src={lightbox.url}
            alt={lightbox.name ?? ''}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      <button className="yiji-launcher" onClick={() => setOpen((o) => !o)} aria-label={tr.title}>
        <ChatIcon />
        {unread > 0 && <span className="yiji-badge">{unread}</span>}
      </button>
    </div>
  );
}
