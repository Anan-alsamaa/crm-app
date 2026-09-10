import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Socket } from 'socket.io-client';
import { connectWidget, type WidgetMessage } from './socket.js';
import { forgetConversation, recallConversation, rememberConversation } from './resume.js';
import { t, isRtl, type WidgetLocale } from './i18n.js';

export interface WidgetConfig {
  gatewayUrl: string;
  token: string;
  /** The language to open in. The customer can switch from the header. */
  locale?: WidgetLocale;
  /**
   * Called when the customer switches language from the header, so the host
   * page can remember the choice for the next visit (see locale.ts). The
   * widget itself keeps no memory: it is embedded in pages it does not own.
   */
  onLocaleChange?: (locale: WidgetLocale) => void;
  /**
   * Open the chat panel immediately on load instead of showing only the
   * launcher. Host pages that embed the widget on a dedicated support page
   * (e.g. a "Chat with us" link) set this so the customer lands straight in
   * the conversation. Defaults to false (launcher-first).
   */
  autoOpen?: boolean;
  /**
   * Where the CLOSE button should send the customer, instead of collapsing
   * the panel back to a launcher.
   *
   * Set when the chat is opened FROM the mobile app (see the walk-in page):
   * the customer believes they are still inside the app, so a close that
   * leaves a floating bubble on a blank web page breaks that belief and
   * strands them. The app registers a scheme — `closeapp://` — and navigating
   * to it hands control back to the app that launched us.
   *
   * Left unset on the ordinary embedded widget, where closing SHOULD just
   * collapse the panel and leave the host page alone.
   */
  closeUrl?: string;
  /**
   * Fallback contact details surfaced when no support agent is online.
   * Host pages can override per vendor; defaults match the Yiji CS desk.
   */
  fallback?: {
    /** Voice line. Shown as a `tel:` chip when no agent is connected. */
    phone?: string;
    /**
     * WhatsApp number, which is NOT the same line as `phone` — the call centre
     * and the WhatsApp business account are different numbers, and sending a
     * customer to wa.me for a landline opens a chat nobody reads.
     */
    whatsapp?: string;
  };
}

/**
 * The WhatsApp link, with the customer's order already typed for them.
 *
 * When every agent is offline the customer is handed a WhatsApp number, and the
 * first thing WeCare asks for is the order. `wa.me` supports `?text=`, so the
 * message arrives pre-written and the customer only presses send — one tap
 * instead of hunting for an order id they may not have to hand.
 *
 * No order id (no Yiji account, no orders, or the lookup did not answer in
 * time) means a plain link, exactly as before. An empty `?text=` would be worse
 * than none: it opens the composer with a blank draft and no clue what to say.
 */
export function whatsappHref(number: string, orderId: string | null): string {
  const base = `https://wa.me/${waNumber(number)}`;
  if (!orderId) return base;
  return `${base}?text=${encodeURIComponent(`orderId: ${orderId}`)}`;
}

/**
 * The clock time a message was sent, in the reader's own language.
 *
 * Time only, not the date: this is revealed on a bubble the customer is
 * already looking at in a thread they are already reading, so the day is
 * context they have. `ar` gets Arabic-Indic digits from the locale, which is
 * what the rest of the widget does.
 */
export function formatTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    // A runtime without full ICU still has to render something sensible.
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

const DEFAULT_FALLBACK = {
  phone: '920012111',
  whatsapp: '0565266122',
};

/**
 * A Saudi local number as wa.me wants it: `05XXXXXXXX` → `9665XXXXXXXX`.
 *
 * A DELIBERATE COPY of `whatsappNumber` in @yiji/shared-types, and the only
 * duplication in this file. This widget is embedded into other people's pages
 * and its dependencies are exactly `preact` and `socket.io-client`; importing a
 * workspace package to reuse six lines would pull zod and the rest of the
 * shared types into a customer-facing bundle to save nothing.
 *
 * The duplication is pinned rather than trusted — `walk-in.test.ts` asserts
 * both implementations agree on the same inputs, so a change to the shared rule
 * that this one misses fails a test instead of quietly sending an offline
 * customer to a chat with nobody.
 *
 * The number on a poster is the local one and a mistyped country code fails
 * silently, so the conversion belongs in code rather than in whoever fills in
 * the config.
 */
function waNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  if (/^9665\d{8}$/.test(digits)) return digits;
  if (/^009665\d{8}$/.test(digits)) return digits.slice(2);
  // Operator-configured rather than customer-typed, so an unusual shape is more
  // likely a number this rule has not met than a mistake. Dropping the link
  // would leave an offline customer with one way out instead of two.
  return digits;
}

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

/** Outside opening hours — the reason, said once, in a glyph. */
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
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
  const [locale, setLocale] = useState<WidgetLocale>(config.locale ?? 'en');
  const tr = t(locale);
  const rtl = isRtl(locale);

  const [open, setOpen] = useState(config.autoOpen ?? false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'error'>(
    'connecting',
  );
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  /** Per-message send timeouts, so an echo can cancel its own. */
  const sendTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Which failed message is showing its Retry/Delete actions. */
  const [openStatusFor, setOpenStatusFor] = useState<string | null>(null);
  const [agentTyping, setAgentTyping] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [branding, setBranding] = useState<Branding>({});
  // The vendor the customer is talking to (from `ready`) — the "Powered by"
  // line names them, not the CRM. Null until known; the footer hides meanwhile
  // rather than flashing the wrong name.
  const [vendorName, setVendorName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * The customer's most recent Yiji order id, prefilled into the WhatsApp
   * fallback. Null until the gateway sends it, and for a customer with no Yiji
   * id or no orders it never arrives — the link then carries no order line.
   */
  const [latestOrderId, setLatestOrderId] = useState<string | null>(null);
  // The customer's own identity from the gateway `ready` event: a returning
  // customer (isNew === false) with a name on file gets greeted by name.
  const [customer, setCustomer] = useState<{ name: string | null; isNew: boolean }>({
    name: null,
    isNew: true,
  });
  const [csat, setCsat] = useState<{ score: number; comment: string; submitted: boolean } | null>(
    null,
  );
  /**
   * How many agents are online — or NULL while we do not yet know.
   *
   * This started at 0, and 0 is also the answer "nobody is online", so the
   * widget asserted "our agents are offline" the instant it painted, several
   * seconds before the socket had said anything. Reported by the owner: the
   * header claimed offline while the panel still read "connecting…", and it
   * then corrected itself to "we're available now" ~6s later. The customer's
   * first impression of a working service was that nobody was there.
   *
   * Null keeps "unknown" distinct from "nobody", so the header can stay quiet
   * until there is something true to say.
   */
  const [agentsOnline, setAgentsOnline] = useState<number | null>(null);
  // True once the "agents are offline" auto-reply has been shown for the current
  // offline period; reset when an agent comes online so it can show again later.
  const offlineNoticedRef = useRef(false);
  const [pending, setPending] = useState<
    Array<{
      id: string;
      name: string;
      type: string;
      preview?: string;
      /** Still in flight — the chip is on screen before the gateway answers. */
      uploading?: boolean;
    }>
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

  const switchLocale = () => {
    const next: WidgetLocale = locale === 'ar' ? 'en' : 'ar';
    setLocale(next);
    config.onLocaleChange?.(next);
    // The greeting is a local bubble written in the language of the moment it
    // was added; say it again in the new one, or the first line of the chat
    // stays in the language the customer just left.
    const nt = t(next);
    const name = customer.name?.trim();
    const greeting =
      !customer.isNew && name ? nt.welcomeNamed.replace('{name}', name) : nt.welcomeNew;
    setMessages((prev) =>
      prev.map((m) => (m.id === GREETING_ID ? { ...m, content: greeting } : m)),
    );
  };

  useEffect(() => {
    // The thread this device opened earlier, if any: offered back so a
    // walk-in who reloads continues their conversation instead of opening a
    // second one (resume.ts). The gateway decides whether to honour it.
    const resume = recallConversation(config.token);
    const socket = connectWidget(
      config.gatewayUrl,
      config.token,
      {
        onStatus: setStatus,
        onLatestOrder: setLatestOrderId,
        /*
         * A refusal from the gateway, surfaced NOW rather than as a 15-second
         * timeout with no reason. Marks whatever is still in flight as failed
         * (so Retry/Delete appear) and states the cause in the thread.
         */
        onServerError: ({ code, message }) => {
          setMessages((prev) =>
            prev.map((m) => (m.status === 'sending' ? { ...m, status: 'failed' as const } : m)),
          );
          for (const t of sendTimers.current.values()) clearTimeout(t);
          sendTimers.current.clear();
          setMessages((prev) => [
            ...prev,
            {
              id: clientId(),
              conversationId: convoRef.current ?? '',
              senderType: 'system',
              // The gateway writes these for a human ("too many messages, slow
              // down"); fall back to our own wording if it ever sends none.
              content: message?.trim() ? message : tr.sendFailed,
              attachments: [],
              createdAt: new Date().toISOString(),
            },
          ]);
          if (code === 'rate_limited') setUploading(false);
        },
        onReady: ({
          conversationId,
          branding: b,
          agentsOnline: count,
          vendorName,
          contact,
          isNew,
        }) => {
          // null on a fresh session; `onConversationReady` fills it in when the
          // customer's first message creates the conversation.
          convoRef.current = conversationId;
          // Remember the thread this device holds; or drop an offered id the
          // gateway declined (solved since, or never this customer's).
          if (conversationId) rememberConversation(config.token, conversationId);
          else forgetConversation(config.token);
          if (b && typeof b === 'object') setBranding(b as Branding);
          setAgentsOnline(count);
          if (vendorName?.trim()) setVendorName(vendorName.trim());
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
                // '' until the conversation exists — the greeting is a local,
                // client-side message and is never persisted, so it does not
                // need a real id.
                conversationId: conversationId ?? '',
                senderType: 'agent',
                content: greeting,
                attachments: [],
                createdAt: new Date().toISOString(),
              },
            ];
          });
        },
        // The conversation now exists — the customer's first message created it.
        // Until this fires the widget has no id, because opening the widget no
        // longer creates a conversation.
        onConversationReady: ({ conversationId }) => {
          convoRef.current = conversationId;
          rememberConversation(config.token, conversationId);
        },
        onAgentsPresence: (count) => {
          setAgentsOnline(count);
          // Agents came back → allow the offline notice to show again if they
          // later go offline within this same session.
          if (count > 0) offlineNoticedRef.current = false;
          broadcastPresenceToHost(count);
        },
        onMessage: (msg) => {
          setMessages((prev) => {
            if (msg.clientMsgId && prev.some((m) => m.clientMsgId === msg.clientMsgId)) {
              // It landed: stop the failure timer and mark the bubble delivered.
              const t = sendTimers.current.get(msg.clientMsgId);
              if (t) clearTimeout(t);
              sendTimers.current.delete(msg.clientMsgId);
              return prev.map((m) =>
                m.clientMsgId === msg.clientMsgId ? { ...msg, status: 'sent' as const } : m,
              );
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
          // A closed thread cannot be resumed; the next visit starts a new one.
          forgetConversation(config.token);
        },
      },
      resume ? { resumeConversationId: resume } : {},
    );
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

  /**
   * Whether a send can actually reach the gateway right now.
   *
   * `ready` alone is not enough, and that gap was a real silent failure: the
   * send BUTTON was gated on `ready`, but the textarea had no disabled state
   * and Enter calls `send()` directly — so during "Connecting…" or
   * "Reconnecting…" a customer could type, press Enter, and watch nothing
   * happen. `send()` bailed at its socket guard and returned without a word.
   * Their complaint simply did not exist.
   *
   * Someone standing in a shop on a weak signal is EXACTLY who this widget is
   * for, so the fix is to make the state visible rather than let the press
   * disappear. The draft is never cleared on a refused send, so nothing they
   * typed is lost — it goes the moment the socket is back.
   */
  const canSend = ready && status === 'connected';

  /**
   * Put one message on the wire and track whether it lands.
   *
   * Shared by the first attempt and by Retry, so a retried message follows
   * exactly the same path as the original — including the timeout. The ack
   * is the gateway echoing the message back with our `clientMsgId`; until
   * that arrives the bubble stays `sending`, and if it never arrives the
   * bubble goes `failed` and offers Retry and Delete.
   *
   * 15 seconds because the gateway's own attachment timeout is 20 and a plain
   * message is far smaller; waiting longer just leaves the customer unsure
   * whether to retype it.
   */
  const sendPayload = (cmid: string, content: string, attachmentIds: string[]) => {
    const socket = socketRef.current;
    if (!socket) {
      setMessages((prev) =>
        prev.map((m) => (m.clientMsgId === cmid ? { ...m, status: 'failed' as const } : m)),
      );
      return;
    }
    setMessages((prev) =>
      prev.map((m) => (m.clientMsgId === cmid ? { ...m, status: 'sending' as const } : m)),
    );
    const timer = setTimeout(() => {
      setMessages((prev) =>
        prev.map((m) =>
          m.clientMsgId === cmid && m.status === 'sending'
            ? { ...m, status: 'failed' as const }
            : m,
        ),
      );
      sendTimers.current.delete(cmid);
    }, 15_000);
    sendTimers.current.set(cmid, timer);
    socket.emit('message:send', {
      // Omitted entirely on a first message — the server decides which
      // conversation this belongs to, and creates it if there is none.
      ...(convoRef.current ? { conversationId: convoRef.current } : {}),
      content,
      ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      clientMsgId: cmid,
    });
  };

  /**
   * WhatsApp's gesture for "when was this sent, and did it arrive".
   *
   * Press and hold, or drag the bubble a little to the left, and the message
   * reveals its timestamp and delivery state. Both gestures are offered because
   * they are the two people already know, and neither costs a visible control
   * in a chat that has to stay uncluttered.
   *
   * Only on the customer's OWN messages: delivery state is a fact about
   * something you sent, and the greeting is not a real message.
   *
   * Tap-to-toggle is kept as the keyboard/desktop path — a long-press has no
   * keyboard equivalent, and a mouse user should not have to hold still for
   * half a second to see a timestamp.
   */
  const bubbleGesture = (id: string) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    const open = () => setOpenStatusFor((cur) => (cur === id ? cur : id));
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return {
      onPointerDown: (e: { clientX: number }) => {
        startX = e.clientX;
        timer = setTimeout(open, 450);
      },
      onPointerMove: (e: { clientX: number }) => {
        // A deliberate leftward drag reveals immediately; anything else (a
        // scroll, a stray wobble) cancels the hold rather than firing it.
        if (startX - e.clientX > 24) {
          cancel();
          open();
        } else if (Math.abs(e.clientX - startX) > 12) {
          cancel();
        }
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      // Long-press on a touch screen otherwise raises the text-selection menu
      // over the top of what we are trying to show.
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
      onClick: () => setOpenStatusFor((cur) => (cur === id ? null : id)),
    };
  };

  /** Try a failed message again, exactly as it was first sent. */
  const retryMessage = (m: WidgetMessage) => {
    if (!m.clientMsgId) return;
    sendPayload(m.clientMsgId, m.content, m.attachments ?? []);
  };

  /** Give up on a failed message and take it off the screen. */
  const discardMessage = (m: WidgetMessage) => {
    const cmid = m.clientMsgId;
    if (cmid) {
      const t = sendTimers.current.get(cmid);
      if (t) clearTimeout(t);
      sendTimers.current.delete(cmid);
    }
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
  };

  const send = () => {
    const content = draft.trim();
    /*
     * NEVER SEND A PLACEHOLDER ID.
     *
     * A chip carries a temporary local id until the gateway answers with the
     * real one. Pressing Enter during a slow upload sent that placeholder, the
     * gateway could not resolve it, and the WHOLE message was refused — text
     * and photo both vanished, and the chip had already been cleared. A 9 MB
     * photo leaves a 20-second window for that.
     *
     * Holding the send until every upload has landed is the honest behaviour:
     * the customer meant to send the picture, not the sentence alone.
     */
    if (pending.some((p) => p.uploading)) return;
    const attachmentIds = pending.map((p) => p.id);
    // NOT gated on convoRef: the conversation is created BY the first message,
    // so on a fresh session there is no id yet and requiring one here would
    // mean the customer could never send anything at all. The gateway resolves
    // (and creates) the conversation, then tells us its id.
    if ((!content && attachmentIds.length === 0) || !socketRef.current) return;
    const cmid = clientId();
    setMessages((prev) => [
      ...prev,
      {
        id: cmid,
        conversationId: convoRef.current ?? '',
        senderType: 'customer',
        content,
        attachments: attachmentIds,
        createdAt: new Date().toISOString(),
        clientMsgId: cmid,
        status: 'sending',
      },
    ]);
    sendPayload(cmid, content, attachmentIds);
    // Agents offline: reassure the customer their message was received and an
    // agent will reply once back. Shown once per offline period so we never spam
    // it; the presence handler resets the flag when an agent comes online.
    if (agentsOnline === 0 && !offlineNoticedRef.current) {
      offlineNoticedRef.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: clientId(),
          conversationId: convoRef.current ?? '',
          senderType: 'system',
          content: tr.offlineAutoReply,
          attachments: [],
          createdAt: new Date().toISOString(),
        },
      ]);
    }
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
      file
        .arrayBuffer()
        .then((content) => {
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
        })
        /* `arrayBuffer()` CAN REJECT, and used to reject into nothing.
           iOS Safari fails here when a photo is still syncing from iCloud, and
           the unhandled rejection left the promise pending for ever: the spinner
           never stopped and the attach button stayed disabled for the rest of
           the session. */
        .catch(() => reject(new Error('unreadable')));
    });

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    /*
     * ONE FILE AT A TIME, AND ONE FAILURE STAYS ONE FAILURE.
     *
     * This used to be a `for...of` inside a single try: the first rejection
     * skipped every remaining file, so picking three photos and having the
     * first one refused silently dropped the other two as well.
     *
     * It also showed the chip only AFTER the upload resolved, which is what
     * made a failed attachment look like nothing had happened at all — the
     * customer tapped, chose a photo, and the composer stayed empty for the
     * full 20-second timeout.
     */
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      // Local object URL → instant image thumbnail in the composer and in the
      // sent bubble, with no need to refetch a private file the customer
      // can't access anyway.
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      // A placeholder id so the chip can appear NOW and be reconciled (or
      // removed) once the gateway answers.
      const tempId = clientId();
      setPending((prev) => [
        ...prev,
        { id: tempId, name: file.name, type: file.type, preview, uploading: true },
      ]);
      try {
        const id = await uploadOne(file);
        attachMetaRef.current[id] = { name: file.name, type: file.type, preview };
        setPending((prev) =>
          prev.map((p) =>
            p.id === tempId ? { id, name: file.name, type: file.type, preview } : p,
          ),
        );
      } catch (err) {
        // Drop this file's chip; keep every other file's.
        setPending((prev) => prev.filter((p) => p.id !== tempId));
        if (preview) URL.revokeObjectURL(preview);
        failures.push(
          `${file.name}${err instanceof Error && err.message ? ` (${err.message})` : ''}`,
        );
      }
    }
    if (failures.length > 0) {
      // Name the files and say WHY. "Could not upload the file" left the
      // customer with no idea whether to retry, shrink it, or pick another.
      setMessages((prev) => [
        ...prev,
        {
          id: clientId(),
          conversationId: convoRef.current ?? '',
          senderType: 'system',
          content: `${tr.attachFailed} ${failures.join(', ')}`,
          attachments: [],
          createdAt: new Date().toISOString(),
        },
      ]);
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
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
          {/* Staging marker. The widget is embedded in a CUSTOMER'S storefront
              and has no /config.js, so unlike the portals this comes from a
              build-time variable. Absent means production, so the warning is
              opt-in and can never appear on a real customer's site by
              accident. */}
          {import.meta.env.VITE_ENVIRONMENT === 'staging' && (
            <div className="yiji-env-banner" role="status">
              Staging &middot; test chat, not monitored
            </div>
          )}
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
              <div className="yiji-header-actions">
                <button
                  type="button"
                  className="yiji-lang"
                  onClick={switchLocale}
                  lang={locale === 'ar' ? 'en' : 'ar'}
                  aria-label={tr.switchLanguage}
                >
                  {tr.switchLanguage}
                </button>
                <button
                  className="yiji-close"
                  onClick={() => {
                    // In app mode the close button is a way OUT, not a way to
                    // minimise. `assign` rather than `href =` so the attempt is
                    // a navigation the app can intercept; if nothing handles the
                    // scheme we still collapse, so the button is never dead.
                    if (config.closeUrl) {
                      try {
                        window.location.assign(config.closeUrl);
                        return;
                      } catch {
                        /* unhandled scheme — fall through to collapsing */
                      }
                    }
                    setOpen(false);
                  }}
                  aria-label={tr.close}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            <div className="yiji-header-team">
              {/* Nothing at all until the gateway has told us. Saying either
                  "available" or "unavailable" before the socket has reported is
                  a guess, and the wrong guess turns a working service into one
                  that looks abandoned. */}
              {agentsOnline !== null && (
                <span className={`yiji-header-status${agentsOnline === 0 ? ' offline' : ''}`}>
                  {agentsOnline === 0 ? tr.offlineTitle : tr.online}
                </span>
              )}
            </div>
          </header>

          {(!ready || status !== 'connected') && (
            <div
              className={`yiji-status${status === 'error' ? ' yiji-status-error' : ''}`}
              data-testid="yiji-status"
            >
              {/*
               * A REFUSED session must not read as a slow one.
               *
               * Every state except `reconnecting` used to render "Connecting…",
               * so a token the gateway rejects — expired, minted with the other
               * environment's secret, or malformed — produced a panel that said
               * "Connecting…" for ever, could not send, and showed neither the
               * online nor the offline details. That is exactly what a customer
               * reported from the Yiji app, twice, and it is indistinguishable
               * from a network problem: waiting cannot fix it, and nothing on
               * screen says so.
               *
               * The gateway already sends the reason on the wire
               * (`{"message":"token invalid: jwt malformed"}`); the widget was
               * throwing it away. It stays out of the customer's message — a
               * JWT error means nothing to them — but the message now tells
               * them the truth: this will not come good on its own, so reopen
               * from the app or phone us.
               */}
              {status === 'error'
                ? tr.cannotConnect
                : status === 'reconnecting'
                  ? tr.reconnecting
                  : tr.connecting}
            </div>
          )}

          <div
            className="yiji-messages"
            ref={listRef}
            role="log"
            aria-label={tr.title}
            aria-live="polite"
            tabIndex={0}
          >
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
                    }${m.id === GREETING_ID ? ' yiji-msg-greeting' : ''}${
                      openStatusFor === m.id ? ' yiji-msg-revealed' : ''
                    }${m.status === 'failed' ? ' yiji-msg-failed' : ''}`}
                    {...(m.senderType === 'customer' && m.id !== GREETING_ID
                      ? bubbleGesture(m.id)
                      : {})}
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
                    {/*
                     * The revealed status row: when it was sent, whether it
                     * arrived, and — if it did not — what to do about it.
                     * Hidden until the customer asks for it (hold, or drag
                     * left) so the thread stays clean.
                     */}
                    {m.senderType === 'customer' &&
                      m.id !== GREETING_ID &&
                      (openStatusFor === m.id || m.status === 'failed') && (
                        <div className="yiji-msg-status">
                          <span className="yiji-msg-time">{formatTime(m.createdAt, locale)}</span>
                          <span className="yiji-msg-state">
                            {m.status === 'failed'
                              ? tr.msgFailed
                              : m.status === 'sending'
                                ? tr.msgSending
                                : tr.msgSent}
                          </span>
                          {m.status === 'failed' && (
                            <span className="yiji-msg-actions">
                              <button type="button" onClick={() => retryMessage(m)}>
                                {tr.msgRetry}
                              </button>
                              <button type="button" onClick={() => discardMessage(m)}>
                                {tr.msgDelete}
                              </button>
                            </span>
                          )}
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
          ) : (
            <>
              {/*
                OFFLINE: A FOOTER, NOT A SCREEN.

                This began as a stacked panel — title, paragraph, and three
                full-width rows each carrying a 36px icon chip — between the
                conversation and the composer. On a phone it filled the widget,
                so a customer who only wanted to type a sentence met a wall of
                contact details and had to scroll past it to reach the box. That
                reads as "go away and phone us", when the truthful message is
                "leave it here and we will reply" — the message IS delivered and
                answered, see send() for the auto-reply.

                What is here now: one reassuring line, then two real action
                CARDS of equal weight. Cards rather than links because these are
                the only two things to do on this surface and they should look
                like it; equal weight because neither is the fallback for the
                other — a customer who wants to speak to somebody picks the
                phone, one who wants a written trail picks WhatsApp.

                The header already carries "our agents are offline", so this
                does not repeat it. Email is gone: the slowest of the channels
                and the one nobody uses from a phone at a counter.
              */}
              {/* Also shown when the session was REFUSED. A customer whose
                  token the gateway rejected cannot chat at all, so the phone
                  and WhatsApp numbers are the only way through — withholding
                  them because `ready` never arrived leaves them with a dead
                  panel and no route to a human. */}
              {(status === 'error' || (ready && agentsOnline === 0)) && (
                <div className="yiji-offline" role="region" aria-label={tr.offlineTitle}>
                  <p className="yiji-offline-body">
                    <span className="yiji-offline-body-icon" aria-hidden>
                      <ClockIcon />
                    </span>
                    <span>{tr.offlineBody}</span>
                  </p>
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
                      href={whatsappHref(
                        config.fallback?.whatsapp ?? DEFAULT_FALLBACK.whatsapp,
                        latestOrderId,
                      )}
                      className="yiji-offline-link yiji-offline-link-wa"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="yiji-offline-link-icon" aria-hidden>
                        <WhatsAppIcon />
                      </span>
                      <span className="yiji-offline-link-text">
                        <span className="yiji-offline-link-label">{tr.offlineWhatsappLabel}</span>
                        <span className="yiji-offline-link-value">
                          {config.fallback?.whatsapp ?? DEFAULT_FALLBACK.whatsapp}
                        </span>
                      </span>
                    </a>
                  </div>
                </div>
              )}
              {pending.length > 0 && (
                <div className="yiji-pending">
                  {pending.map((p) => (
                    <span
                      className={`yiji-chip${p.preview ? ' yiji-chip-img' : ''}${
                        p.uploading ? ' yiji-chip-uploading' : ''
                      }`}
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
                      {!p.uploading && (
                        <button
                          type="button"
                          onClick={() => removePending(p.id)}
                          aria-label={tr.removeAttachment}
                        >
                          ×
                        </button>
                      )}
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
                    disabled={!canSend || uploading}
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
                        // Swallowed while offline rather than calling send():
                        // this is the path that used to bypass the disabled
                        // button and drop the message in silence.
                        e.preventDefault();
                        if (canSend) send();
                      }
                    }}
                    rows={1}
                  />
                </div>
                <button
                  className="yiji-send"
                  onClick={send}
                  aria-label={tr.send}
                  disabled={!canSend || (draft.trim().length === 0 && pending.length === 0)}
                >
                  <SendIcon />
                </button>
              </div>
            </>
          )}

          {vendorName && (
            <p className="yiji-footer">
              <strong>{tr.poweredBy.replace('{vendor}', vendorName)}</strong>
            </p>
          )}
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
