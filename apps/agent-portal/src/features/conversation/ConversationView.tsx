import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';
import {
  EmojiPicker,
  Linkify,
  Avatar,
  ChevronDownIcon,
  CloseIcon,
  ConfirmDialog,
  cn,
  formatRelative,
  Skeleton,
  SparkleIcon,
  Spinner,
  toast,
  useIsDesktop,
} from '@yiji/ui';
import {
  SOCKET_EVENTS,
  isDialablePhone,
  displayContactName,
  isAutomatedAgentMessage,
  type MessageDeleted,
  type MessageEdited,
  type MessageNew,
} from '@yiji/shared-types';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useUpdateContact } from '../contacts/api.js';
import { getSocket, uploadAttachment } from '../../lib/socket.js';
import { noteSelfSend } from '../../lib/sound.js';
import { formatBytes, isImage, validateAttachment, ATTACHMENT_ACCEPT } from '../../lib/files.js';
import { FileGlyph } from '../../components/FileGlyph.js';
import {
  conversationVendorId,
  useAgents,
  useConversation,
  useMessages,
  type ConversationMessage,
} from '../inbox/api.js';
import { AiPanel } from '../ai/AiPanel.js';
import { AttachmentChips } from './AttachmentChips.js';
import { ConversationToolbar } from './ConversationToolbar.js';
import { ConversationSidebar } from './ConversationSidebar.js';
import { QuickReplies } from './QuickReplies.js';
import { EnhanceButton } from './EnhanceButton.js';
import { PushUnreachableNotice } from './PushUnreachableNotice.js';
import { resolveMentions } from './mentions.js';
import { InlineMessageEditor, OwnMessageActions } from './MessageEditControls.js';
import {
  applyMessageDeleted,
  applyMessageEdited,
  canOfferMessageActions,
} from './message-edits.js';

let seq = 0;
const clientId = () => `a${Date.now()}_${seq++}`;

interface NoteNew {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
  clientMsgId?: string;
  isInternalNote: true;
}

/** Calendar-day key for grouping the thread into Today / Yesterday / date sections. */
function dayKeyOf(iso: string | null): string {
  return iso ? new Date(iso).toDateString() : '';
}

/** Group consecutive same-sender messages so avatars only render once per run. */
function groupRuns(msgs: ConversationMessage[]): ConversationMessage[][] {
  const groups: ConversationMessage[][] = [];
  for (const m of msgs) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0]!.sender_type === m.sender_type &&
      last[0]!.is_internal_note === m.is_internal_note &&
      /* The automatic welcome is its own run (owner, 2026-10-06), or a real
         reply right after it would be labelled "Automatic welcome" — or the
         welcome labelled as the agent's own words. */
      isAutomatedAgentMessage(last[0]!) === isAutomatedAgentMessage(m)
    ) {
      last.push(m);
    } else {
      groups.push([m]);
    }
  }
  return groups;
}

export function ConversationView({
  conversationId,
  onBack,
}: {
  conversationId: string;
  /** Mobile single-column: return to the inbox list. */
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const messagesQuery = useMessages(conversationId);
  const conversation = useConversation(conversationId);
  // Governs the monthly AI budget, so the panel only mounts once known.
  const aiVendorId = conversationVendorId(conversation.data);
  /** AI assistance is opt-in per session — see the trigger by the composer. */
  const [aiOpen, setAiOpen] = useState(false);
  const agents = useAgents();
  const [live, setLive] = useState<ConversationMessage[]>([]);
  /*
   * EDIT / DELETE AN OWN REPLY (owner, 2026-10-05 (EMA-33)). `now` ticks so the
   * actions disappear once the 15-minute window closes without a reload; the
   * gateway refuses a late attempt regardless.
   */
  const { user } = useAuth();
  const myId = user?.id ?? null;
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [customerTyping, setCustomerTyping] = useState(false);
  // Live customer presence for this conversation (gateway `customer:presence`):
  // null until the first event, then drives the header's online / "New customer"
  // line. isNew is sticky across an offline transition (the offline event omits
  // it) so a new customer who closes their tab still reads as new.
  const [customerPresence, setCustomerPresence] = useState<{
    online: boolean;
    isNew: boolean;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const [internalNote, setInternalNote] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mentionMenu, setMentionMenu] = useState<{ query: string; from: number } | null>(null);
  const [pending, setPending] = useState<
    Array<{ id: string; name: string; type: string; size: number; preview?: string }>
  >([]);
  const [uploading, setUploading] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last message id we've sent a read:ack for, so opening/viewing a conversation
  // clears its unread badge once (not on every render/refetch).
  const lastReadRef = useRef<string | null>(null);

  useEffect(() => {
    setLive([]);
    setEditing(null);
    setConfirmDeleteId(null);
    setCustomerTyping(false);
    setCustomerPresence(null);
    lastReadRef.current = null;
    setDraft('');
    lastQuickReplyRef.current = null;
    setInternalNote(false);
    setDetailsOpen(false);
    setMentionMenu(null);
    setPending([]);
    setUploading(false);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    isTypingRef.current = false;
  }, [conversationId]);

  // Esc closes the mobile details overlay.
  useEffect(() => {
    if (!detailsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDetailsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailsOpen]);

  const signalTyping = () => {
    if (!socketRef.current) return;
    if (!isTypingRef.current) {
      socketRef.current.emit(SOCKET_EVENTS.typingStart, { conversationId });
      isTypingRef.current = true;
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit(SOCKET_EVENTS.typingStop, { conversationId });
      isTypingRef.current = false;
      typingTimeoutRef.current = null;
    }, 2000);
  };
  const stopTyping = () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (isTypingRef.current && socketRef.current) {
      socketRef.current.emit(SOCKET_EVENTS.typingStop, { conversationId });
      isTypingRef.current = false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    /*
     * The detach, reachable by REACT rather than by a Promise.
     *
     * This is the whole fix. The listeners are attached inside an async IIFE,
     * so the cleanup that IIFE returns goes to a Promise and React never calls
     * it — every conversation switch left `messageNew` attached, bound to a
     * closure holding the PREVIOUS conversation's id and the previous
     * component's `setLive`.
     *
     * What that looked like (owner, 2026-09-30): two agents answering two
     * customers at the same moment. Shatha's reply flashed for two seconds
     * inside Mohamed's open chat with 0566461807, then jumped to where it
     * belonged when he switched threads. THE DATABASE WAS ALWAYS CORRECT —
     * every message is stored against the right conversation; only the screen
     * lied, which is the most alarming possible version of this bug because it
     * looks like a customer's message reaching the wrong person.
     *
     * The previous attempt detached `connect` alone in the outer cleanup and
     * left the rest, which is why the reconnect symptom went away and this one
     * did not.
     */
    let detach: (() => void) | null = null;
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socketRef.current = socket;
      socket.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId });

      /*
       * RE-SUBSCRIBE AFTER A RECONNECT, OR THE THREAD GOES MUTE.
       *
       * Socket.IO rooms are per socket id. A reconnect issues a NEW id and
       * every room membership is lost, so the one subscribe above stops
       * covering this conversation. The gateway re-joins an agent's own rooms
       * on connect, but only for chats assigned to them or unassigned — a chat
       * handed to their team and owned by a colleague is not re-joined at all.
       *
       * The React effect does not re-run on a reconnect, so nothing repaired
       * it: the agent kept an open thread that had simply gone quiet, while the
       * customer typed into it and waited. Refetching too, because anything
       * that arrived during the gap was never delivered.
       */
      const onReconnect = () => {
        socket.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId });
        void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
        void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      };
      socket.on('connect', onReconnect);

      const onNew = (msg: MessageNew) => {
        if (msg.conversationId !== conversationId) return;
        const confirmed: ConversationMessage = {
          id: msg.id,
          sender_type: msg.senderType,
          content: msg.content,
          is_internal_note: false,
          date_created: msg.createdAt,
          conversation_id: msg.conversationId,
          // Who sent it, so an agent's own live reply can be edited (EMA-33).
          /* An agent message with no user id is the automatic welcome ONLY when
             the gateway says so (owner, 2026-10-06); otherwise "unknown",
             never null — null would relabel a person's reply as automated. */
          sender_user:
            msg.senderUserId ?? (msg.senderType === 'agent' && !msg.automated ? undefined : null),
          // message:new only carries attachment ids (no type/size). For our own
          // optimistic echo we keep the richer local metadata below; for inbound
          // messages we refetch to resolve filename/type/size into thumbnails.
          attachments: (msg.attachments ?? []).map((id) => ({
            id,
            filename: null,
            type: null,
            filesize: null,
          })),
        };
        setLive((prev) => {
          // Reconcile the optimistic echo: if we already rendered this message
          // optimistically (temp id === clientMsgId), swap it for the confirmed
          // one (real id, pending cleared) — but keep the optimistic attachment
          // metadata so image thumbnails don't flicker back to generic chips.
          if (msg.clientMsgId && prev.some((m) => m.id === msg.clientMsgId)) {
            return prev.map((m) =>
              m.id === msg.clientMsgId
                ? { ...confirmed, attachments: m.attachments ?? confirmed.attachments }
                : m,
            );
          }
          return prev.some((m) => m.id === msg.id) ? prev : [...prev, confirmed];
        });
        // Inbound attachments arrive as bare ids — refetch to hydrate type/size
        // so they render as thumbnails / typed chips rather than placeholders.
        if (!msg.clientMsgId && msg.attachments && msg.attachments.length > 0) {
          void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
        }
      };
      const onNoteNew = (n: NoteNew) => {
        if (n.conversationId !== conversationId) return;
        const confirmed: ConversationMessage = {
          id: n.id,
          sender_type: 'agent',
          content: n.content,
          is_internal_note: true,
          date_created: n.createdAt,
          conversation_id: n.conversationId,
        };
        setLive((prev) => {
          // Reconcile our own optimistic note, exactly as replies do. The
          // gateway has always echoed `clientMsgId` on note:new; notes simply
          // never used it, so the optimistic copy and the confirmed one would
          // have shown as two notes.
          if (n.clientMsgId && prev.some((m) => m.id === n.clientMsgId)) {
            return prev.map((m) => (m.id === n.clientMsgId ? confirmed : m));
          }
          return prev.some((m) => m.id === n.id) ? prev : [...prev, confirmed];
        });
      };
      const onTyping = (e: { conversationId: string; who: string; isTyping: boolean }) => {
        if (e.conversationId === conversationId && e.who === 'customer')
          setCustomerTyping(e.isTyping);
      };
      const onCustomerPresence = (e: {
        conversationId: string;
        online: boolean;
        isNew?: boolean;
      }) => {
        if (e.conversationId !== conversationId) return;
        // Keep isNew across the offline event (which omits it) so a new customer
        // who closes their tab still reads as "New customer", just offline.
        setCustomerPresence((prev) => ({
          online: e.online,
          isNew: e.isNew ?? prev?.isNew ?? false,
        }));
      };
      const onChanged = (e: { conversationId: string }) => {
        if (e.conversationId !== conversationId) return;
        /*
         * Refetch the THREAD as well as the row.
         *
         * This is a shared inbox: `conversation:changed` means a colleague
         * acted on the chat you are reading. Refetching only the conversation
         * row flipped the toolbar under the agent's cursor while the messages
         * beside it stayed stale — so whatever the other agent said, or the
         * reply that prompted them to solve it, was not on screen.
         */
        void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
        void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
      };
      const onNoteDeleted = (e: { conversationId: string; noteId: string }) => {
        if (e.conversationId !== conversationId) return;
        setLive((prev) => prev.filter((m) => m.id !== e.noteId));
        void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
      };
      /*
       * An agent corrected or withdrew a reply (EMA-33) — possibly a colleague,
       * possibly this agent in another tab. Patch BOTH lists the thread merges,
       * or the cached copy would put the old wording back.
       */
      const onMessageEdited = (e: MessageEdited) => {
        if (e.conversationId !== conversationId) return;
        setLive((prev) => applyMessageEdited(prev, e));
        qc.setQueryData<ConversationMessage[]>(['messages', conversationId], (prev) =>
          prev ? applyMessageEdited(prev, e) : prev,
        );
      };
      const onMessageDeleted = (e: MessageDeleted) => {
        if (e.conversationId !== conversationId) return;
        setLive((prev) => applyMessageDeleted(prev, e));
        qc.setQueryData<ConversationMessage[]>(['messages', conversationId], (prev) =>
          prev ? applyMessageDeleted(prev, e) : prev,
        );
      };
      // The gateway rejects work by emitting `error` (rate_limited,
      // attachment_rejected, forbidden, bad_payload, persist_failed,
      // note_delete_*). Without a listener those failures were SILENT — a
      // rejected attachment or a throttled send just looked like nothing
      // happened. Surface them as a toast so the agent knows to retry.
      const onSocketError = (e: { code?: string; message?: string }) => {
        const code = e?.code ?? 'unknown';
        toast.error(
          t(`conversation.socketError.${code}`, {
            defaultValue: e?.message || t('errors.actionFailed', { ns: 'common' }),
          }),
        );
      };
      socket.on(SOCKET_EVENTS.messageNew, onNew);
      socket.on(SOCKET_EVENTS.noteNew, onNoteNew);
      socket.on(SOCKET_EVENTS.noteDeleted, onNoteDeleted);
      socket.on(SOCKET_EVENTS.messageEdited, onMessageEdited);
      socket.on(SOCKET_EVENTS.messageDeleted, onMessageDeleted);
      socket.on(SOCKET_EVENTS.typingUpdate, onTyping);
      socket.on(SOCKET_EVENTS.customerPresence, onCustomerPresence);
      socket.on(SOCKET_EVENTS.conversationChanged, onChanged);
      socket.on(SOCKET_EVENTS.error, onSocketError);
      /*
       * ASSIGNED, not returned. Returning this hands it to the Promise the IIFE
       * produces — which nothing ever calls.
       *
       * Each listener is removed BY REFERENCE, so a sibling component's
       * handlers for the same event are untouched. `socket.off('connect')` with
       * no second argument, which is what stood here before, removes EVERY
       * connect listener on the shared socket including other features'.
       */
      detach = () => {
        socket.off(SOCKET_EVENTS.messageNew, onNew);
        socket.off(SOCKET_EVENTS.noteNew, onNoteNew);
        socket.off(SOCKET_EVENTS.noteDeleted, onNoteDeleted);
        socket.off(SOCKET_EVENTS.messageEdited, onMessageEdited);
        socket.off(SOCKET_EVENTS.messageDeleted, onMessageDeleted);
        socket.off(SOCKET_EVENTS.typingUpdate, onTyping);
        socket.off(SOCKET_EVENTS.customerPresence, onCustomerPresence);
        socket.off(SOCKET_EVENTS.conversationChanged, onChanged);
        socket.off(SOCKET_EVENTS.error, onSocketError);
        socket.off('connect', onReconnect);
      };
      /* The effect was torn down while `getSocket()` was still in flight, so the
         cleanup below already ran and cannot run again. Detach immediately or
         these listeners outlive the component that made them. */
      if (cancelled) detach();
    })();
    return () => {
      cancelled = true;
      detach?.();
      detach = null;
    };
  }, [conversationId, qc, t]);

  /**
   * THE LAST GATE: a message that is not this conversation's never renders.
   *
   * The owner's requirement after 2026-09-30, and it is the right one: a reply
   * must not appear in another customer's chat even if something upstream goes
   * wrong. Everything the thread, the sidebar and the shared-media grid show
   * flows through `all`, so this is the single place where that can be made
   * true rather than hoped for.
   *
   * WHY A SECOND CHECK. The delivery-point guard
   * (`msg.conversationId !== conversationId`) could not catch the bug that
   * caused this: a leaked listener compared against the id IT had captured, so
   * the guard passed and a dead component's `setLive` ran. This one compares
   * against the id being RENDERED, which is the only id that can be wrong from
   * the reader's point of view.
   *
   * Rows from `messagesQuery` are trusted: the query is keyed by conversation,
   * so a row arriving there is already scoped. Only `live` — socket-delivered
   * and optimistic — is stamped and checked. An UNSTAMPED live message is kept,
   * so this can never blank a thread if a future code path forgets the stamp;
   * it only ever rejects a message that positively names a different chat.
   */
  const all = useMemo(() => {
    const base = messagesQuery.data ?? [];
    const seen = new Set(base.map((m) => m.id));
    const belongsHere = (m: (typeof live)[number]) =>
      m.conversation_id === undefined || m.conversation_id === conversationId;
    const mine = live.filter(belongsHere);
    if (mine.length !== live.length) {
      // Never silent. If this ever fires, something upstream is misrouting and
      // the console is where that gets noticed before a customer does.
      console.error(
        '[conversation] dropped %d message(s) belonging to another conversation',
        live.length - mine.length,
      );
    }
    return [...base, ...mine.filter((m) => !seen.has(m.id))];
  }, [messagesQuery.data, live, conversationId]);

  // Internal notes live in the sidebar, not the conversation thread.
  const threadMessages = useMemo(() => all.filter((m) => !m.is_internal_note), [all]);
  // Images shared in this thread — feeds the sidebar's "Shared media" grid.
  const sharedMedia = useMemo(
    () =>
      threadMessages.flatMap((m) =>
        (m.attachments ?? []).filter((a) => isImage(a.type, a.filename)),
      ),
    [threadMessages],
  );
  const notes = useMemo(() => all.filter((m) => m.is_internal_note), [all]);
  const grouped = useMemo(() => groupRuns(threadMessages), [threadMessages]);

  // Mark the conversation read on VIEW so its inbox unread badge clears — not
  // only when the agent replies. The gateway has the read:ack handler
  // (markConversationRead) but nothing emitted it. Guarded so we only emit when
  // the latest message changes, and we optimistically zero the badge across all
  // cached inbox queries so it clears instantly.
  useEffect(() => {
    if (threadMessages.length === 0) return;
    const lastId = threadMessages[threadMessages.length - 1]!.id;
    if (lastReadRef.current === lastId) return;
    lastReadRef.current = lastId;
    /*
     * AN ACK THAT FAILED MUST BE ALLOWED TO HAPPEN AGAIN.
     *
     * `lastReadRef` was stamped BEFORE the emit and the promise had no catch,
     * so a socket that could not be obtained (a token refresh failure) produced
     * an unhandled rejection AND permanently suppressed the retry for that
     * message. The badge was zeroed on the next line regardless, so the agent
     * saw it clear — and the true count came back on the next refetch, reading
     * as a new message that was never there.
     *
     * Releasing the stamp on failure lets the next render try again.
     */
    void getSocket()
      .then((s) => s.emit(SOCKET_EVENTS.readAck, { conversationId, lastMessageId: lastId }))
      .catch(() => {
        if (lastReadRef.current === lastId) lastReadRef.current = null;
      });
    qc.setQueriesData({ queryKey: ['conversations'] }, (old: unknown) =>
      Array.isArray(old)
        ? old.map((c) =>
            c && (c as { id?: string }).id === conversationId
              ? { ...(c as object), unread_count_agent: 0 }
              : c,
          )
        : old,
    );
  }, [conversationId, threadMessages, qc]);

  const deleteNote = (noteId: string) => {
    if (!socketRef.current) return;
    // Optimistic removal: BOTH the unmerged `live` buffer AND the cached
    // `messages` query result. Removing from `live` only is not enough —
    // if the note had already been fetched from Directus it lives in
    // `messagesQuery.data` (= the merged `base`), and the UI would keep
    // showing it from there.
    setLive((prev) => prev.filter((m) => m.id !== noteId));
    qc.setQueryData<ConversationMessage[]>(['messages', conversationId], (prev) =>
      prev ? prev.filter((m) => m.id !== noteId) : prev,
    );
    socketRef.current.emit(SOCKET_EVENTS.noteDelete, { conversationId, noteId });
    // Failsafe refetch: if the gateway silently rejected the delete (e.g.
    // service-account missing `messages.delete` permission) no `note:deleted`
    // broadcast comes back, so without this the note would only "reappear"
    // on the user's next reload. Re-querying Directus after a short delay
    // makes a silent failure visible (note pops back) rather than leaving
    // the UI lying about it.
    window.setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
    }, 1500);
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [all, customerTyping]);

  const send = () => {
    const content = draft.trim();
    const attachmentIds = pending.map((p) => p.id);
    // A reply needs text OR at least one attachment; internal notes are text-only.
    if (internalNote ? !content : !content && attachmentIds.length === 0) return;
    if (!socketRef.current) {
      // Pressing send with no socket used to do NOTHING — no message, no
      // error, the text just sat there. The draft is deliberately left intact
      // so nothing is lost, but the person has to be told why their note went
      // nowhere, or they press Enter harder.
      toast.error(
        t('conversation.notConnected', {
          defaultValue: 'Not connected yet — your text is safe, try again in a moment.',
        }),
      );
      return;
    }
    noteSelfSend(); // don't beep on the echo of our own message
    const cmid = clientId();
    if (internalNote) {
      const mentions = resolveMentions(content, agents.data ?? []);
      socketRef.current.emit(SOCKET_EVENTS.noteAdd, {
        conversationId,
        content,
        mentions,
        clientMsgId: cmid,
      });
      // Optimistic, like a reply. Without this a note only appeared once the
      // server echoed it back, so on a slow connection pressing Enter looked
      // like it had done nothing at all — and a note is exactly the thing an
      // agent types quickly and moves on from.
      setLive((prev) => [
        ...prev,
        {
          id: cmid,
          sender_type: 'agent',
          content,
          is_internal_note: true,
          date_created: new Date().toISOString(),
          conversation_id: conversationId,
          pending: true,
        },
      ]);
    } else {
      socketRef.current.emit(SOCKET_EVENTS.messageSend, {
        conversationId,
        content,
        ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
        clientMsgId: cmid,
      });
      // Optimistic: render the reply instantly (id = clientMsgId, pending) so
      // the thread feels zero-latency. onNew reconciles it to the confirmed
      // message (real id) when the gateway echoes it back.
      setLive((prev) => [
        ...prev,
        {
          id: cmid,
          sender_type: 'agent',
          content,
          is_internal_note: false,
          date_created: new Date().toISOString(),
          conversation_id: conversationId,
          attachments: pending.map((p) => ({
            id: p.id,
            filename: p.name,
            type: p.type,
            filesize: p.size,
          })),
          pending: true,
        },
      ]);
    }
    setDraft('');
    lastQuickReplyRef.current = null;
    pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    setPending([]);
    setMentionMenu(null);
    stopTyping();
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    // Reset textarea height after sending.
    if (draftRef.current) draftRef.current.style.height = 'auto';
  };

  // Map a gateway upload-failure code (or a client-side rejection) to a
  // specific, actionable message — so "attachment not working" tells the agent
  // WHY (wrong type / too big / rate-limited) instead of a blank "failed".
  const uploadErrorMessage = (reason: string): string => {
    if (/too large|size/i.test(reason))
      return t('conversation.attachTooLarge', {
        defaultValue: 'File is too large. Maximum size is 10 MB.',
      });
    if (/not allowed|type|unknown/i.test(reason))
      return t('conversation.attachBadType', {
        defaultValue: 'Unsupported file type. Allowed: images, PDF, and text files.',
      });
    if (/rate_limited|rate limit/i.test(reason))
      return t('conversation.attachRateLimited', {
        defaultValue: 'Too many uploads. Please wait a moment and try again.',
      });
    if (/timeout/i.test(reason))
      return t('conversation.attachTimeout', {
        defaultValue: 'Upload timed out. Check your connection and try again.',
      });
    return t('conversation.attachFailed', { defaultValue: 'Could not upload the file.' });
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);

    // Validate client-side against the gateway policy first: reject wrong types
    // and oversized files instantly with a clear reason, rather than uploading
    // bytes that the gateway will reject after a round-trip.
    const accepted: File[] = [];
    for (const file of picked) {
      const reject = validateAttachment(file);
      if (reject) toast.error(uploadErrorMessage(reject === 'size' ? 'too large' : 'not allowed'));
      else accepted.push(file);
    }
    if (accepted.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    try {
      for (const file of accepted) {
        try {
          const up = await uploadAttachment(file);
          // Local object URL gives an instant image thumbnail in the composer —
          // no server round-trip needed to preview what's about to be sent.
          const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
          setPending((prev) => [
            ...prev,
            { id: up.id, name: file.name, type: file.type, size: file.size, preview },
          ]);
        } catch (err) {
          // Surface the gateway's specific reason (e.g. "file too large",
          // "type X not allowed", "rate_limited"). A dead session is handled
          // globally (toast + redirect), so don't double-report it here.
          const reason = err instanceof Error ? err.message : '';
          if (reason !== 'session_expired') toast.error(uploadErrorMessage(reason));
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const removePending = (id: string) =>
    setPending((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter((p) => p.id !== id);
    });

  const onDraftChange = (value: string, caret: number) => {
    setDraft(value);
    if (value.trim().length === 0) stopTyping();
    else signalTyping();
    const upTo = value.slice(0, caret);
    const m = /(?:^|\s)@([\w.+-]*)$/.exec(upTo);
    if (internalNote && m)
      setMentionMenu({ query: m[1]!.toLowerCase(), from: caret - m[1]!.length });
    else setMentionMenu(null);
    if (draftRef.current) {
      draftRef.current.style.height = 'auto';
      draftRef.current.style.height = `${Math.min(draftRef.current.scrollHeight, 160)}px`;
    }
  };

  /**
   * The live "/…" filter for the ready replies.
   *
   * Only when the slash STARTS the draft: mid-sentence a slash is a slash, and
   * an agent typing "9/10" should not watch the reply row start hunting.
   *
   * `null` means "not searching" — DISTINCT from `''`, which is a bare `/` with
   * nothing typed after it yet. They used to be the same value, and that is why
   * typing `/` on its own did nothing: the panel opened on `!!query`, an empty
   * string is falsy, so the list appeared only once a second character landed
   * (ops, 2026-10-04). A bare `/` is the whole gesture — it must open the list
   * with everything in it.
   */
  const slashMatch = /^\/(.*)$/.exec(draft);
  const replyFilter = slashMatch?.[1] ?? '';
  const replySearching = slashMatch !== null;

  /**
   * What the CUSTOMER has written, for language ranking.
   *
   * Deliberately not the whole transcript: an Arabic template we sent earlier
   * would otherwise make an English conversation rank Arabic first, and the
   * agent would fight the row every time.
   */
  const customerText = useMemo(
    () =>
      all
        .filter((m) => m.sender_type === 'customer' && !m.is_internal_note)
        .map((m) => m.content ?? '')
        .join(' '),
    [all],
  );

  /**
   * Put a ready reply in the box.
   *
   * INSERTS rather than replaces — the ops portal overwrites whatever is there,
   * and one mis-click costing a half-written reply is all it takes for an agent
   * to stop trusting the row. A "/query" is consumed (it was the search, not the
   * message); anything else is appended to what is already written.
   */
  /** The canned reply currently sitting in the composer. Kept only so the
   *  UNDO below can tell "I just replaced your text" from a normal edit. */
  const lastQuickReplyRef = useRef<string | null>(null);
  /** What the composer held before the last canned reply replaced it. */
  const replacedDraftRef = useRef<string | null>(null);

  /**
   * A canned reply REPLACES the draft. Always — typed text included.
   *
   * It used to stack onto anything hand-written, on the reasoning that a
   * mis-click must never cost a half-written reply. In practice that made the
   * row untrustworthy in the other direction: an agent who typed a few words,
   * then reached for the canned version, got the two glued together and had to
   * delete their own sentence by hand every time. Reported from production
   * (owner, 2026-09-09) as the remaining half of a fix that only ever covered
   * canned-over-canned.
   *
   * Replacing is what the button looks like it does, so it is what it does.
   * The mis-click worry is answered by making the replacement UNDOABLE rather
   * than by refusing to replace: Ctrl/Cmd+Z in the composer restores exactly
   * what was there, and the row says so the first time it takes something.
   */
  /**
   * Put the emoji where the caret is, not at the end.
   *
   * An agent mid-sentence expects it inline; appending would make them cut and
   * paste. The caret is then placed AFTER the emoji so typing continues
   * naturally, and focus returns to the textarea because the click took it to
   * the picker.
   *
   * `setSelectionRange` is deferred to the next frame: React has not yet
   * re-rendered with the new value, so setting it now would be overwritten.
   */
  const insertEmoji = (emoji: string) => {
    const el = draftRef.current;
    const at = el?.selectionStart ?? draft.length;
    const next = draft.slice(0, at) + emoji + draft.slice(el?.selectionEnd ?? at);
    /*
     * THROUGH `onDraftChange`, NOT `setDraft` (ops, 2026-10-03: "button is
     * visible, on click nothing comes").
     *
     * The composer is `rows={1}` and its height is set IMPERATIVELY — only
     * `onDraftChange` measures `scrollHeight` and grows the box. Calling
     * `setDraft` directly stored the emoji and left the textarea one line tall,
     * so on a draft that already filled that line the character landed below
     * the clip: really inserted, genuinely invisible, and indistinguishable
     * from a dead button.
     *
     * It was reported against the sunglasses face, but nothing here is
     * emoji-specific — 😎 is a plain single-codepoint character like its
     * neighbours. Every emoji had this, and only a full line of text made it
     * show.
     */
    onDraftChange(next, at + emoji.length);
    requestAnimationFrame(() => {
      const box = draftRef.current;
      if (!box) return;
      box.focus();
      const caret = at + emoji.length;
      box.setSelectionRange(caret, caret);
    });
  };

  const insertQuickReply = (text: string) => {
    setDraft((prev) => {
      const base = prev.trimEnd();
      // Remember only real work — not blank, and not a canned reply we put
      // there ourselves, which nobody needs restored.
      const tookRealWork = !!base && base !== lastQuickReplyRef.current;
      replacedDraftRef.current = tookRealWork ? prev : null;
      /* Say so when we take something the agent wrote. Silently swallowing a
         half-typed sentence is what makes a row untrustworthy — one line, only
         when there was something to lose, and it names the way back. */
      if (tookRealWork) {
        toast(
          t('inbox.quickReplyReplaced', {
            defaultValue: 'Replaced your text — press Ctrl+Z to undo',
          }),
        );
      }
      lastQuickReplyRef.current = text;
      return text;
    });
    requestAnimationFrame(() => {
      draftRef.current?.focus();
      if (draftRef.current) {
        draftRef.current.style.height = 'auto';
        draftRef.current.style.height = `${Math.min(draftRef.current.scrollHeight, 160)}px`;
      }
    });
  };

  /**
   * THE ENHANCED REPLY, landed in the composer (ops, 2026-10-04).
   *
   * Two things this must get right, and both were learned the hard way:
   *
   *  1. THROUGH `onDraftChange`, never `setDraft`. The composer is `rows={1}`
   *     and its height is set imperatively — only `onDraftChange` measures
   *     `scrollHeight` and grows the box. This is the same fault that made the
   *     emoji button look dead (ops, 2026-10-03), and it would bite harder
   *     here: an enhanced reply is usually LONGER than the draft it replaces,
   *     so the agent would see one clipped line and conclude nothing happened.
   *     The AI panel's own `onReplySuggested` had this bug too; it is fixed
   *     alongside, since both land AI text in the same box.
   *
   *  2. THE AGENT'S OWN WORDS STAY RECOVERABLE. Accepting a suggestion is now
   *     a deliberate second press — the proposal is read beside the draft
   *     before it replaces anything (ops, 2026-10-04) — but the undo stays,
   *     because "Use this" is still one click away from losing a carefully
   *     worded reply. It reuses the canned reply's `replacedDraftRef` plus
   *     Ctrl+Z rather than inventing a second idea of undo.
   */
  const applyEnhanced = (text: string) => {
    const prior = draft;
    /* Only worth restoring if there was real work there. Enhance is disabled on
       an empty draft, so in practice there always is. */
    replacedDraftRef.current = prior.trim() ? prior : null;
    lastQuickReplyRef.current = null;
    onDraftChange(text, text.length);
    if (replacedDraftRef.current) {
      toast(
        t('inbox.enhancedReplaced', {
          defaultValue: 'Enhanced your text — press Ctrl+Z to undo',
        }),
      );
    }
    requestAnimationFrame(() => {
      const box = draftRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(text.length, text.length);
    });
  };

  /**
   * Ctrl/Cmd+Z immediately after a canned reply gives the agent their own
   * words back.
   *
   * The browser's native undo cannot: the value was changed programmatically,
   * so the textarea's own history has no entry to step back to. Without this,
   * "replace" would mean "lose", which is the whole reason the old code
   * appended instead.
   */
  const undoQuickReply = (): boolean => {
    const prior = replacedDraftRef.current;
    if (prior === null) return false;
    replacedDraftRef.current = null;
    lastQuickReplyRef.current = null;
    setDraft(prior);
    return true;
  };

  const insertMention = (email: string) => {
    if (!mentionMenu) return;
    const local = email.split('@')[0] ?? '';
    const before = draft.slice(0, mentionMenu.from);
    const after = draft.slice(mentionMenu.from + mentionMenu.query.length);
    const next = `${before}${local} ${after}`;
    setDraft(next);
    setMentionMenu(null);
    requestAnimationFrame(() => draftRef.current?.focus());
  };

  const filteredAgents = useMemo(() => {
    if (!mentionMenu || !agents.data) return [];
    const q = mentionMenu.query;
    return agents.data
      .filter(
        (a) =>
          (a.email?.toLowerCase().includes(q) ?? false) ||
          (a.first_name?.toLowerCase().includes(q) ?? false) ||
          (a.last_name?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 6);
  }, [mentionMenu, agents.data]);

  /*
   * ABOVE THE LOADING RETURN, because these are HOOKS.
   *
   * They were below it, so while messages loaded React saw three fewer hooks
   * than on the next render — "rendered more hooks than during the previous
   * render", which crashes the component the instant a conversation finishes
   * loading. Four E2E specs failed on it, each after two retries: the chat
   * never painted, so the close button, the ticket flow and the widget round
   * trip all had nothing to click.
   *
   * `nameIsMissing` below is a plain derivation and may stay where it reads
   * best; only the hooks are pinned here.
   */
  const updateContactName = useUpdateContact();
  const [askName, setAskName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  if (messagesQuery.isLoading)
    return (
      <div className="flex h-full flex-col" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t('actions.loading', { ns: 'common' })}</span>
        {/* Toolbar placeholder */}
        <div className="flex h-14 shrink-0 items-center gap-3 px-3 sm:px-5">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        </div>
        {/* Thread placeholder — alternating inbound/outbound bubbles */}
        <div className="flex-1 overflow-hidden">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
            {[
              { me: false, w: 'w-52' },
              { me: true, w: 'w-40' },
              { me: false, w: 'w-64' },
              { me: true, w: 'w-32' },
            ].map((b, i) => (
              <div key={i} className={cn('flex gap-2.5', b.me ? 'flex-row-reverse' : 'flex-row')}>
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <Skeleton className={cn('h-10 rounded-2xl', b.w)} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  const c = conversation.data;
  /* THROUGH `displayContactName`, so a name that is really a phone number or a
     machine address (`…@yiji.com`, `…@AFCO.com` — what Yiji registers app
     customers under) resolves to the MOBILE the agent actually needs, rather
     than being printed as-is. The email remains the last resort, after the
     phone. */
  const contactName =
    displayContactName(c?.contact?.name, c?.contact?.phone) ||
    c?.contact?.phone ||
    c?.contact?.email ||
    t('inbox.unknownContact');

  /*
   * WE DO NOT KNOW THIS CUSTOMER'S NAME.
   *
   * Most contacts arrive from the app or a QR code carrying only a phone, and
   * the stored "name" is then the number itself — `displayContactName` exists
   * because 44 of 77 contacts on production were in exactly that state.
   *
   * The sidebar has always been able to fix this, but it is a 24px pencil in a
   * right-hand panel nobody looks at, so agents ignore it (owner, 2026-10-03).
   * The prompt therefore goes in the HEADER, where the agent is already reading
   * the customer's name, and says what to do rather than offering an icon.
   */
  const nameIsMissing =
    !c?.contact?.name?.trim() ||
    isDialablePhone(c.contact.name) ||
    /* A MACHINE ADDRESS IS NOT A NAME EITHER. Yiji registers app customers
       under a synthesised address (`…@yiji.com`, `…@AFCO.com`), and a header
       showing one is exactly the "we do not know who this is" case the prompt
       exists for — it simply did not recognise the shape (ops, 2026-10-04). */
    displayContactName(c.contact.name, c.contact.phone) !== c.contact.name ||
    c.contact.name === c.contact.phone;

  const dayLabel = (iso: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
    if (diff <= 0) return t('conversation.today', { defaultValue: 'Today' });
    if (diff === 1) return t('conversation.yesterday', { defaultValue: 'Yesterday' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // An order id in the sidebar's Orders panel opens the New ticket PAGE for that
  // order — a route, not a dialog, because that is the screen the operations
  // team already fills in.
  //
  // Only the conversation id travels: the order itself rode across as the
  // conversation's pinned order, which lives in sessionStorage and so survives
  // both the navigation and a refresh of the new page.
  const openTicketForOrder = () => {
    setDetailsOpen(false);
    navigate(`/new-ticket?conversation=${encodeURIComponent(conversationId)}`);
  };

  /*
   * Send the edit / delete and let the broadcast update the screen. Not
   * optimistic: a refusal (window closed, not yours) comes back as a socket
   * error toast, and showing the change first would mean silently undoing it.
   * A push notification already delivered to the customer's phone cannot be
   * recalled — this only changes the thread.
   */
  const saveEdit = (messageId: string, content: string) => {
    setEditing(null);
    socketRef.current?.emit(SOCKET_EVENTS.messageEdit, { conversationId, messageId, content });
  };
  const confirmDeleteMessage = () => {
    const messageId = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!messageId) return;
    socketRef.current?.emit(SOCKET_EVENTS.messageDelete, { conversationId, messageId });
  };

  const copyMessage = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(t('conversation.copied', { defaultValue: 'Copied' })),
      () => undefined,
    );
  };

  return (
    // Instagram-DM zone on the dark aurora canvas: an elevated card with a thin
    // ring so it floats off the ink, a softly-tinted thread surface, aurora
    // gradient bubbles outgoing and defined solid bubbles incoming.
    <div className="flex h-full gap-3 text-foreground">
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]">
        {/* Toolbar — slim row of status/priority/agent controls. */}
        {c && (
          <ConversationToolbar
            conversation={c}
            customerPresence={customerPresence}
            onBack={onBack}
            onToggleDetails={() => setDetailsOpen(true)}
          />
        )}

        {/* Thread — clean solid surface; no gradient behind reading text. */}
        <div ref={listRef} className="relative flex-1 overflow-auto bg-secondary/25">
          {/* min-h-full + justify-end bottom-anchors the thread: a short
              conversation sits just above the composer instead of floating at
              the top with an empty void below. Long threads overflow + scroll
              normally. */}
          <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end gap-5 px-5 py-6">
            {/* Conversation-start header — the Instagram move: the contact's
                profile opens the scrollback instead of an empty void. Also the
                zero-message state: the same composed profile block with a
                "No messages yet" line, never dead space over the composer. */}
            {(threadMessages.length > 0 || c) && (
              <div className="flex flex-col items-center gap-3 pb-8 pt-10 text-center">
                <span className="rounded-full bg-primary/30 p-[2px]">
                  <span className="block rounded-full bg-canvas p-[3px]">
                    <Avatar
                      name={c?.contact?.name}
                      email={c?.contact?.email}
                      phone={c?.contact?.phone}
                      size="lg"
                    />
                  </span>
                </span>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-lg font-bold tracking-tight text-foreground">
                      {contactName}
                    </div>
                    {/*
                      ASK FOR THE NAME, HERE, WHERE THE AGENT IS LOOKING.

                      Not another pencil: a prompt that says what to do. The
                      sidebar's editor has always worked and agents ignore it,
                      because a 24px icon in a right-hand panel is not an
                      instruction (owner, 2026-10-03).

                      Only when we genuinely have no name — a contact whose
                      "name" is their own phone number counts as no name, which
                      is most of them.
                    */}
                    {nameIsMissing && c?.contact?.id && !askName && (
                      <button
                        type="button"
                        onClick={() => {
                          setNameDraft('');
                          setAskName(true);
                        }}
                        className="rounded-full border border-dashed border-primary/40 px-2.5 py-0.5 text-2xs font-medium text-primary transition-colors duration-fast ease-out hover:bg-primary/[0.08]"
                      >
                        {t('conversation.askName', {
                          defaultValue: 'Ask for their name',
                        })}
                      </button>
                    )}
                  </div>
                  {nameIsMissing && c?.contact?.id && askName && (
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = nameDraft.trim();
                        if (!v) return;
                        updateContactName.mutate(
                          { id: c.contact!.id, patch: { name: v } },
                          { onSuccess: () => setAskName(false) },
                        );
                      }}
                    >
                      <input
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        placeholder={t('conversation.namePlaceholder', {
                          defaultValue: 'Type the name they gave you',
                        })}
                        aria-label={t('sidebar.name', { defaultValue: 'Name' })}
                        className="h-7 w-56 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      />
                      <button
                        type="submit"
                        disabled={!nameDraft.trim() || updateContactName.isPending}
                        className="rounded-md bg-primary px-2.5 py-1 text-2xs font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAskName(false)}
                        className="rounded-md px-2 py-1 text-2xs text-muted-foreground hover:text-foreground"
                      >
                        {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
                      </button>
                    </form>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {threadMessages.length > 0
                      ? t('conversation.startedOn', {
                          defaultValue: 'Chat started {{date}}',
                          date: dayLabel(threadMessages[0]!.date_created),
                        })
                      : t('inbox.noMessagesYet', { defaultValue: 'No messages yet' })}
                  </div>
                </div>
              </div>
            )}
            {grouped.map((run, runIdx) => {
              const head = run[0]!;
              const isAgent = head.sender_type === 'agent';
              /*
               * THE THIRD SENDER. A chat has three voices, not two: the agent,
               * the customer, and the SYSTEM — the idle-close goodbye is written
               * with `sender_type: 'system'` and belongs to no person.
               *
               * This was a binary (`isAgent` or else the customer), so a system
               * message inherited the customer's whole identity: their name,
               * their avatar carrying their phone and email, and their side of
               * the thread. The owner saw the farewell WE send appear as though
               * the customer had sent it (2026-10-02). The stored rows were
               * right all along — all 10 on production carry
               * `sender_type: 'system'` with a null user and a null contact —
               * so this was only ever a rendering fault.
               *
               * The customer's own widget already renders these as a third,
               * centred kind. The two surfaces now agree.
               */
              const isSystem = head.sender_type === 'system';
              const isNote = isAgent && head.is_internal_note;
              /*
               * THE AUTOMATIC WELCOME (owner, 2026-10-06): an ordinary agent
               * bubble — the customer sees it as one — but labelled for what
               * it is. "You" would tell the agent they had already answered a
               * customer nobody has spoken to yet.
               */
              const isAutoWelcome = isAutomatedAgentMessage(head);
              const last = run[run.length - 1]!;
              const senderLabel = isSystem
                ? t('conversation.system', { defaultValue: 'System' })
                : isAgent
                  ? isNote
                    ? t('conversation.internalNote')
                    : isAutoWelcome
                      ? t('conversation.autoWelcome', { defaultValue: 'Automatic welcome' })
                      : t('conversation.you', { defaultValue: 'You' })
                  : contactName;
              const time = last.pending
                ? t('conversation.sending', { defaultValue: 'Sending…' })
                : formatRelative(last.date_created);
              // Day separator when the calendar day changes from the previous run.
              const prevRun = grouped[runIdx - 1];
              const showDay =
                !!head.date_created &&
                (!prevRun || dayKeyOf(head.date_created) !== dayKeyOf(prevRun[0]!.date_created));

              return (
                <Fragment key={runIdx}>
                  {showDay && (
                    <div className="flex items-center justify-center py-1">
                      <span className="rounded-full bg-secondary/70 px-2.5 py-0.5 text-2xs font-medium text-muted-foreground ring-1 ring-foreground/[0.04] backdrop-blur-sm">
                        {dayLabel(head.date_created)}
                      </span>
                    </div>
                  )}
                  <div
                    className={cn(
                      'flex gap-2.5',
                      isSystem
                        ? 'flex-col items-center'
                        : isAgent
                          ? 'flex-row-reverse text-end'
                          : 'flex-row',
                    )}
                  >
                    {/* NO AVATAR ON A SYSTEM MESSAGE. It belongs to no person,
                        and the customer's avatar here is what made our own
                        farewell look like something they had written. */}
                    {!isSystem && (
                      <Avatar
                        name={isAgent ? (isAutoWelcome ? senderLabel : 'You') : c?.contact?.name}
                        email={isAgent ? undefined : c?.contact?.email}
                        phone={isAgent ? undefined : c?.contact?.phone}
                        size="sm"
                        className={cn(isAgent && isNote && 'ring-2 ring-warning/40 ring-offset-1')}
                      />
                    )}
                    <div
                      className={cn(
                        'flex max-w-[78%] min-w-0 flex-col gap-1',
                        isAgent && 'items-end',
                        isSystem && 'max-w-[90%] items-center text-center',
                      )}
                    >
                      <div className="flex items-baseline gap-2 text-2xs">
                        <span className="font-medium text-foreground">{senderLabel}</span>
                        <span className="text-muted-foreground tabular-nums">{time}</span>
                      </div>
                      <div
                        className={cn(
                          'flex flex-col gap-0.5',
                          isAgent && 'items-end',
                          isSystem && 'items-center',
                        )}
                      >
                        {run.map((m, i) => {
                          const isLast = i === run.length - 1;
                          const isDeleted = !!m.deleted_at;
                          const hasContent = !isDeleted && (m.content ?? '').trim().length > 0;
                          const ownActions = !isDeleted && canOfferMessageActions(m, myId, now);
                          const isEditing = ownActions && editing?.id === m.id;
                          return (
                            <div
                              key={m.id}
                              className={cn(
                                'flex flex-col gap-1',
                                isSystem ? 'items-center' : isAgent ? 'items-end' : 'items-start',
                              )}
                            >
                              {/* A withdrawn reply (EMA-33): a placeholder, never its words or files. */}
                              {isDeleted && (
                                <div className="rounded-2xl px-4 py-2 text-sm italic text-muted-foreground ring-1 ring-foreground/[0.06]">
                                  {t('conversation.messageDeleted', {
                                    defaultValue: 'This message was deleted',
                                  })}
                                </div>
                              )}
                              {isEditing && editing && (
                                <InlineMessageEditor
                                  initial={editing.text}
                                  onSave={(content) => saveEdit(m.id, content)}
                                  onCancel={() => setEditing(null)}
                                />
                              )}
                              {hasContent && !isEditing && (
                                <div
                                  className={cn(
                                    'group/msg flex items-center gap-1.5',
                                    isAgent ? 'flex-row-reverse' : 'flex-row',
                                  )}
                                >
                                  <div
                                    className={cn(
                                      'px-4 py-2.5 text-[15px] leading-relaxed break-words text-start max-w-fit',
                                      'motion-safe:animate-message-in',
                                      // Board bubbles: outgoing = solid jade,
                                      // incoming = token bubble surface with a
                                      // hairline ring. One rounding everywhere.
                                      isNote
                                        ? 'bg-warning/15 text-warning-foreground ring-1 ring-warning/20'
                                        : isSystem
                                          ? /* Quiet and neutral: this is the app
                                               speaking, not a person, so it must
                                               not borrow either side's colour. */
                                            'bg-secondary/60 text-muted-foreground ring-1 ring-foreground/[0.04] text-center text-sm'
                                          : isAgent
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-bubble text-foreground ring-1 ring-foreground/[0.06]',
                                      // rounded-2xl consistency, tail only on the LAST bubble of a run.
                                      'rounded-2xl',
                                      // No tail on a system bubble — a tail points at a sender.
                                      isLast && isAgent && !isSystem && 'rounded-ee-md',
                                      isLast && !isAgent && !isSystem && 'rounded-es-md',
                                      // Optimistic message: dim until the server confirms.
                                      m.pending && 'opacity-60',
                                    )}
                                  >
                                    <p className="whitespace-pre-wrap">
                                      {/* Links clickable (owner, 2026-09-30). A
                                          customer pasting a tracking URL, or an
                                          agent sending one, had to be copied by
                                          hand. Rendered as NODES, never as HTML:
                                          this text is whatever a customer typed. */}
                                      <Linkify text={m.content} />
                                    </p>
                                    {m.edited_at && (
                                      <span className="mt-0.5 block text-2xs opacity-70">
                                        {t('conversation.messageEdited', {
                                          defaultValue: 'edited',
                                        })}
                                      </span>
                                    )}
                                  </div>
                                  {/*
                                    COPY, OR EDIT — never both (owner, 2026-10-06).
                                    On the agent's own reply that can still be
                                    changed, the hover button IS Edit (with
                                    Delete); on everything else it stays Copy.
                                    Either way it appears only while that one
                                    message is hovered.
                                  */}
                                  {ownActions ? (
                                    <OwnMessageActions
                                      canEdit
                                      onEdit={() => setEditing({ id: m.id, text: m.content ?? '' })}
                                      onDelete={() => setConfirmDeleteId(m.id)}
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => copyMessage(m.content ?? '')}
                                      aria-label={t('conversation.copyMessage', {
                                        defaultValue: 'Copy message',
                                      })}
                                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,color,background-color] duration-fast ease-out hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/msg:opacity-100"
                                    >
                                      <svg
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        className="h-3.5 w-3.5"
                                        aria-hidden
                                      >
                                        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                                        <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
                                      </svg>
                                    </button>
                                  )}
                                </div>
                              )}
                              {/* Only rendered when there ARE files, so an empty
                                  wrapper adds no gap under a text bubble. */}
                              {!isDeleted && !!m.attachments?.length && (
                                <div
                                  className={cn(
                                    'group/msg flex items-center gap-1.5',
                                    isAgent ? 'flex-row-reverse' : 'flex-row',
                                  )}
                                >
                                  <AttachmentChips
                                    attachments={m.attachments}
                                    align={isAgent ? 'end' : 'start'}
                                  />
                                  {/* An attachment-only reply can still be withdrawn. */}
                                  {ownActions && !hasContent && (
                                    <OwnMessageActions
                                      canEdit={false}
                                      onEdit={() => undefined}
                                      onDelete={() => setConfirmDeleteId(m.id)}
                                    />
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}

            {customerTyping && (
              <div className="flex gap-2.5">
                <Avatar
                  name={c?.contact?.name}
                  email={c?.contact?.email}
                  phone={c?.contact?.phone}
                  size="sm"
                />
                <div className="rounded-2xl rounded-es-md bg-bubble px-3.5 py-2.5 ring-1 ring-foreground/[0.06]">
                  <span className="flex items-center gap-1" aria-hidden>
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse [animation-delay:120ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse [animation-delay:240ms]" />
                  </span>
                  <span className="sr-only">{t('conversation.customerTyping')}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Reply composer — floating card lit by focus. */}
        <div>
          {/* max-w-3xl matches the thread column above — the composer, tabs and
              quick replies share the bubbles' start/end edges instead of
              overhanging them. */}
          <div className="mx-auto max-w-3xl px-5 pb-5 pt-3">
            {/* AI assistance sits directly above the reply box: an agent
                reaches for it WHILE writing, so it belongs beside the box
                rather than in a side panel they have to look away to find.
                A suggestion still only ever lands in the composer for the
                agent to edit — nothing reaches the customer unreviewed. */}
            {/*
              THEY MAY NOT KNOW YOU WROTE (EMA-11).

              Above the composer, where the agent is about to type — not in the
              header they scrolled past. It only appears on a chat the AGENT
              started and whose customer the push gateway has marked
              permanently unreachable; the component itself holds that rule, so
              there is one place to read it.

              Hidden on an internal note for the same reason the canned replies
              are: a note goes to the team, and nudging the customer about it
              makes no sense.
            */}
            {!internalNote && (
              <PushUnreachableNotice
                className="mb-2"
                pushUnreachableAt={c?.push_unreachable_at}
                initiatedBy={c?.initiated_by}
                phone={c?.contact?.phone}
                name={c?.contact?.name}
              />
            )}
            {/* Ready-made replies, directly above the box — the operations portal
                puts them here and agents already reach for them there. Hidden on
                an internal note: a canned customer reply is never the right
                thing to say to the team. */}
            {!internalNote && (
              <div className="mb-1 flex items-start gap-2">
                <QuickReplies
                  className="min-w-0 flex-1"
                  customerText={customerText}
                  query={replyFilter}
                  searching={replySearching}
                  vars={{
                    order: c?.last_order_id ?? null,
                    name: c?.contact?.name ?? null,
                    brand: c?.last_order_snapshot?.brandName ?? null,
                    restaurant: c?.last_order_snapshot?.restaurantName ?? null,
                  }}
                  onPick={insertQuickReply}
                />
                {/* ENHANCE — improve what the agent already wrote (ops,
                    2026-10-04). Beside Quick replies, because those are the two
                    ways of not typing a reply from scratch, and an agent
                    reaches for them in the same moment. */}
                <EnhanceButton
                  conversationId={conversationId}
                  vendorId={aiVendorId}
                  draft={draft}
                  onAccept={applyEnhanced}
                  onError={(m) => toast.error(m)}
                />
                {aiVendorId && (
                  <button
                    type="button"
                    onClick={() => setAiOpen((v) => !v)}
                    aria-expanded={aiOpen}
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-2xs font-semibold',
                      'ring-1 ring-inset transition-colors duration-fast ease-out',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      aiOpen
                        ? 'bg-primary/15 text-primary ring-primary/25'
                        : 'bg-secondary/50 text-muted-foreground ring-border hover:text-foreground',
                    )}
                  >
                    <SparkleIcon size={13} />
                    {t('ai.title', { defaultValue: 'AI' })}
                    <ChevronDownIcon
                      size={12}
                      className={cn('transition-transform duration-fast', aiOpen && 'rotate-180')}
                    />
                  </button>
                )}
              </div>
            )}
            {!internalNote && aiVendorId && aiOpen && (
              <AiPanel
                className="mb-2"
                conversationId={conversationId}
                vendorId={aiVendorId}
                draft={draft}
                /* Through `applyEnhanced`, not `setDraft`: the panel's
                   suggestion lands in the same one-line composer and had the
                   same invisible-growth bug as the emoji button. */
                onReplySuggested={applyEnhanced}
              />
            )}

            {/* Tabs: reply / internal note (text-button style, no chip chrome) */}
            <div className="mb-1 flex items-center gap-4 text-xs">
              <button
                type="button"
                aria-pressed={!internalNote}
                onClick={() => {
                  setInternalNote(false);
                  setMentionMenu(null);
                }}
                className={cn(
                  'relative h-8 font-medium transition-colors duration-fast ease-out',
                  !internalNote
                    ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('conversation.tab.reply', { defaultValue: 'Reply' })}
              </button>
              <button
                type="button"
                aria-pressed={internalNote}
                onClick={() => setInternalNote(true)}
                className={cn(
                  'relative inline-flex h-8 items-center gap-1.5 font-medium transition-colors duration-fast ease-out',
                  internalNote
                    ? 'text-warning after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-warning'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                {t('conversation.tab.note', { defaultValue: 'Internal note' })}
              </button>
              {internalNote && (
                <span className="ms-auto text-warning text-2xs">
                  {t('conversation.mentionHint')}
                </span>
              )}
            </div>

            <div
              className={cn(
                'group relative rounded-2xl transition-[box-shadow,background-color] duration-fast ease-out',
                // The input-well look: recessed secondary surface with an inset
                // hairline at rest, lifting to the card surface + a 2px jade
                // ring on focus. The note mode swaps the hue wholesale — the
                // two focus rings are mutually exclusive branches because cn()
                // is a plain joiner and conflicting rings are unpredictable.
                internalNote
                  ? 'bg-warning/10 focus-within:ring-2 focus-within:ring-warning/50'
                  : 'bg-secondary/50 ring-1 ring-inset ring-foreground/10 focus-within:bg-card focus-within:ring-2 focus-within:ring-primary/40',
              )}
            >
              {/* Pending attachments (uploaded, not yet sent) — image thumbnails
                  preview instantly from the local file; other types show a
                  typed chip with size. Each has a remove control. */}
              {pending.length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 pt-3">
                  {pending.map((p) =>
                    p.preview ? (
                      <div
                        key={p.id}
                        className="group/att relative h-16 w-16 overflow-hidden rounded-lg ring-1 ring-foreground/[0.08]"
                      >
                        <img src={p.preview} alt={p.name} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removePending(p.id)}
                          aria-label={t('conversation.removeAttachment', {
                            defaultValue: 'Remove attachment',
                          })}
                          className="absolute end-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-foreground/75 text-background opacity-0 transition-opacity duration-fast ease-out hover:bg-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/att:opacity-100"
                        >
                          <CloseIcon size={11} />
                        </button>
                      </div>
                    ) : (
                      <span
                        key={p.id}
                        className="inline-flex max-w-[15rem] items-center gap-2 rounded-lg bg-secondary px-2 py-1.5 ring-1 ring-foreground/[0.05]"
                      >
                        <FileGlyph type={p.type} filename={p.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {p.name}
                          </span>
                          <span className="block text-2xs tabular-nums text-muted-foreground">
                            {formatBytes(p.size)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removePending(p.id)}
                          aria-label={t('conversation.removeAttachment', {
                            defaultValue: 'Remove attachment',
                          })}
                          className="shrink-0 text-muted-foreground transition-colors duration-fast hover:text-foreground"
                        >
                          <CloseIcon size={13} />
                        </button>
                      </span>
                    ),
                  )}
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept={ATTACHMENT_ACCEPT}
                onChange={(e) => void onPickFiles(e.target.files)}
              />

              {/* Attach · textarea · send sit in one flex row so the buttons stay
                  aligned to the textarea and bottom-anchor as it grows, instead
                  of floating absolutely over the text. */}
              <div className="flex items-end gap-1 px-1.5 py-1.5">
                {/* Attach — reply mode only (internal notes are text-only) */}
                {!internalNote && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    aria-label={t('conversation.attach', { defaultValue: 'Attach file' })}
                    className={cn(
                      'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                      'text-muted-foreground transition-colors duration-fast ease-out',
                      'hover:bg-secondary hover:text-foreground active:enabled:scale-95',
                      'disabled:opacity-40 disabled:cursor-not-allowed',
                    )}
                  >
                    {uploading ? (
                      <Spinner size={16} />
                    ) : (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-[18px] w-[18px]"
                        aria-hidden
                      >
                        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                    )}
                  </button>
                )}

                {/* EMOJI, to the right of Attach (owner, 2026-09-30). Reply mode
                    only, for the same reason Attach is: an internal note is a
                    line to a colleague, not a message to a customer. */}
                {!internalNote && (
                  <EmojiPicker
                    label={t('conversation.emoji', { defaultValue: 'Insert emoji' })}
                    onPick={insertEmoji}
                  />
                )}

                <textarea
                  ref={draftRef}
                  rows={1}
                  className={cn(
                    'block min-w-0 flex-1 resize-none bg-transparent py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground',
                    internalNote ? 'px-2' : 'px-1',
                    'border-none outline-none focus:ring-0',
                  )}
                  value={draft}
                  placeholder={
                    internalNote
                      ? t('conversation.notePlaceholder')
                      : t('conversation.replyPlaceholder')
                  }
                  onChange={(e) =>
                    onDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                    /* Undo a canned reply that just replaced typed text. The
                       browser cannot do this itself — the value was set
                       programmatically, so the textarea's own history has no
                       step to go back to — and without it "replace" would mean
                       "lose". Only handled when there IS something to restore,
                       so ordinary undo is untouched. */
                    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                      if (undoQuickReply()) e.preventDefault();
                    }
                    if (e.key === 'Escape') setMentionMenu(null);
                  }}
                />

                <button
                  type="button"
                  onClick={send}
                  disabled={draft.trim().length === 0 && (internalNote || pending.length === 0)}
                  aria-label={t('actions.send', { ns: 'common' })}
                  className={cn(
                    'group/send inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                    'transition-[transform,background-color,box-shadow,opacity] duration-fast ease-out',
                    'hover:enabled:scale-105 hover:enabled:shadow-md active:enabled:scale-90',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    internalNote
                      ? 'bg-warning text-warning-foreground'
                      : 'bg-primary text-primary-foreground hover:brightness-110',
                  )}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-4 w-4 transition-transform duration-fast ease-out group-hover/send:translate-x-px rtl:scale-x-[-1]"
                    aria-hidden
                  >
                    <path d="M1.6 13.7 14 8.4c.55-.23.55-1.01 0-1.24L1.6 1.86c-.55-.24-1.13.27-.94.85L2.3 7.32 8.5 8 2.3 8.68l-1.64 4.61c-.2.58.39 1.09.94.85Z" />
                  </svg>
                </button>
              </div>

              {mentionMenu && filteredAgents.length > 0 && (
                <div className="absolute bottom-full start-1 mb-2 max-h-56 w-72 overflow-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-lg animate-scale-in origin-bottom">
                  {filteredAgents.map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => a.email && insertMention(a.email)}
                      className="block w-full px-3 py-2 text-start text-sm hover:bg-secondary"
                    >
                      <span className="font-medium text-foreground">{a.first_name ?? a.email}</span>{' '}
                      <span className="text-xs text-muted-foreground">{a.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p className="mt-2 text-2xs text-muted-foreground">
              <kbd className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] ring-1 ring-inset ring-foreground/[0.06]">
                Enter
              </kbd>{' '}
              {t('conversation.sendHint', { defaultValue: 'to send' })}
              {' · '}
              <kbd className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] ring-1 ring-inset ring-foreground/[0.06]">
                Shift+Enter
              </kbd>{' '}
              {t('conversation.newlineHint', { defaultValue: 'for newline' })}
            </p>
          </div>
        </div>
      </div>

      {isDesktop ? (
        <ConversationSidebar
          conversationId={conversationId}
          notes={notes}
          media={sharedMedia}
          onDeleteNote={deleteNote}
          resizable
          onCreateTicketForOrder={openTicketForOrder}
        />
      ) : (
        detailsOpen && (
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
            <div
              aria-hidden
              onClick={() => setDetailsOpen(false)}
              className="absolute inset-0 bg-black/55 backdrop-blur-sm motion-safe:animate-fade-in"
            />
            {/* Plain shadow-2xl: a foreground-based shadow inverts on the dark
                theme (near-white bloom instead of depth) — the design-law
                foreground-scrim/shadow trap. */}
            <div className="absolute inset-y-0 end-0 flex bg-card shadow-2xl motion-safe:animate-slide-in-drawer">
              <button
                type="button"
                onClick={() => setDetailsOpen(false)}
                aria-label={t('actions.close', { ns: 'common', defaultValue: 'Close' })}
                className="absolute end-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <CloseIcon size={18} />
              </button>
              <ConversationSidebar
                conversationId={conversationId}
                notes={notes}
                media={sharedMedia}
                onDeleteNote={deleteNote}
                className="w-[20rem] max-w-[85vw]"
                onCreateTicketForOrder={openTicketForOrder}
              />
            </div>
          </div>
        )
      )}

      {/* Withdrawing a reply the customer may already have read (EMA-33). */}
      <ConfirmDialog
        open={!!confirmDeleteId}
        destructive
        title={t('conversation.deleteMessageConfirm', {
          defaultValue: 'Delete this message?',
        })}
        description={t('conversation.deleteMessageWarning', {
          defaultValue:
            'The customer will see “This message was deleted” instead. A notification already sent to their phone cannot be recalled.',
        })}
        confirmLabel={t('actions.delete', { ns: 'common', defaultValue: 'Delete' })}
        cancelLabel={t('actions.cancel', { ns: 'common' })}
        onConfirm={confirmDeleteMessage}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
