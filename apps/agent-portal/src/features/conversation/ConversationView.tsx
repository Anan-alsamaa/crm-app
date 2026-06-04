import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Socket } from 'socket.io-client';
import { Avatar, CloseIcon, cn, formatRelative, Skeleton, useIsDesktop } from '@yiji/ui';
import { SOCKET_EVENTS, type MessageNew } from '@yiji/shared-types';
import { getSocket } from '../../lib/socket.js';
import { useAgents, useConversation, useMessages, type ConversationMessage } from '../inbox/api.js';
import { ConversationToolbar } from './ConversationToolbar.js';
import { ConversationSidebar } from './ConversationSidebar.js';
import { resolveMentions } from './mentions.js';

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

/** Group consecutive same-sender messages so avatars only render once per run. */
function groupRuns(msgs: ConversationMessage[]): ConversationMessage[][] {
  const groups: ConversationMessage[][] = [];
  for (const m of msgs) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0]!.sender_type === m.sender_type &&
      last[0]!.is_internal_note === m.is_internal_note
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
  const isDesktop = useIsDesktop();
  const messagesQuery = useMessages(conversationId);
  const conversation = useConversation(conversationId);
  const agents = useAgents();
  const [live, setLive] = useState<ConversationMessage[]>([]);
  const [customerTyping, setCustomerTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [internalNote, setInternalNote] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mentionMenu, setMentionMenu] = useState<{ query: string; from: number } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const isTypingRef = useRef(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLive([]);
    setCustomerTyping(false);
    setDraft('');
    setInternalNote(false);
    setDetailsOpen(false);
    setMentionMenu(null);
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
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socketRef.current = socket;
      socket.emit(SOCKET_EVENTS.conversationSubscribe, { conversationId });

      const onNew = (msg: MessageNew) => {
        if (msg.conversationId !== conversationId) return;
        setLive((prev) =>
          prev.some((m) => m.id === msg.id)
            ? prev
            : [
                ...prev,
                {
                  id: msg.id,
                  sender_type: msg.senderType,
                  content: msg.content,
                  is_internal_note: false,
                  date_created: msg.createdAt,
                },
              ],
        );
      };
      const onNoteNew = (n: NoteNew) => {
        if (n.conversationId !== conversationId) return;
        setLive((prev) =>
          prev.some((m) => m.id === n.id)
            ? prev
            : [
                ...prev,
                {
                  id: n.id,
                  sender_type: 'agent',
                  content: n.content,
                  is_internal_note: true,
                  date_created: n.createdAt,
                },
              ],
        );
      };
      const onTyping = (e: { conversationId: string; who: string; isTyping: boolean }) => {
        if (e.conversationId === conversationId && e.who === 'customer')
          setCustomerTyping(e.isTyping);
      };
      const onChanged = (e: { conversationId: string }) => {
        if (e.conversationId !== conversationId) return;
        void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      };
      const onNoteDeleted = (e: { conversationId: string; noteId: string }) => {
        if (e.conversationId !== conversationId) return;
        setLive((prev) => prev.filter((m) => m.id !== e.noteId));
        void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
      };
      socket.on(SOCKET_EVENTS.messageNew, onNew);
      socket.on(SOCKET_EVENTS.noteNew, onNoteNew);
      socket.on(SOCKET_EVENTS.noteDeleted, onNoteDeleted);
      socket.on(SOCKET_EVENTS.typingUpdate, onTyping);
      socket.on(SOCKET_EVENTS.conversationChanged, onChanged);
      return () => {
        socket.off(SOCKET_EVENTS.messageNew, onNew);
        socket.off(SOCKET_EVENTS.noteNew, onNoteNew);
        socket.off(SOCKET_EVENTS.noteDeleted, onNoteDeleted);
        socket.off(SOCKET_EVENTS.typingUpdate, onTyping);
        socket.off(SOCKET_EVENTS.conversationChanged, onChanged);
      };
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, qc]);

  const all = useMemo(() => {
    const base = messagesQuery.data ?? [];
    const seen = new Set(base.map((m) => m.id));
    return [...base, ...live.filter((m) => !seen.has(m.id))];
  }, [messagesQuery.data, live]);

  // Internal notes live in the sidebar, not the conversation thread.
  const threadMessages = useMemo(() => all.filter((m) => !m.is_internal_note), [all]);
  const notes = useMemo(() => all.filter((m) => m.is_internal_note), [all]);
  const grouped = useMemo(() => groupRuns(threadMessages), [threadMessages]);

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
    if (!content || !socketRef.current) return;
    const cmid = clientId();
    if (internalNote) {
      const mentions = resolveMentions(content, agents.data ?? []);
      socketRef.current.emit(SOCKET_EVENTS.noteAdd, {
        conversationId,
        content,
        mentions,
        clientMsgId: cmid,
      });
    } else {
      socketRef.current.emit(SOCKET_EVENTS.messageSend, {
        conversationId,
        content,
        clientMsgId: cmid,
      });
    }
    setDraft('');
    setMentionMenu(null);
    stopTyping();
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    // Reset textarea height after sending.
    if (draftRef.current) draftRef.current.style.height = 'auto';
  };

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
                <Skeleton className={cn('h-10 rounded-[18px]', b.w)} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  const c = conversation.data;
  const contactName = c?.contact?.name ?? c?.contact?.email ?? t('inbox.unknownContact');

  return (
    <div className="flex h-full">
      <div className="flex flex-1 min-w-0 flex-col">
        {/* Toolbar — slim row of status/priority/agent controls. */}
        {c && (
          <ConversationToolbar
            conversation={c}
            onBack={onBack}
            onToggleDetails={() => setDetailsOpen(true)}
          />
        )}

        {/* Thread — soft mesh wash so it doesn't feel like a void. */}
        <div
          ref={listRef}
          className="relative flex-1 overflow-auto"
          style={{
            background:
              'radial-gradient(at 8% 8%, oklch(var(--primary) / 0.04) 0%, transparent 40%), radial-gradient(at 92% 92%, oklch(var(--secondary-brand) / 0.04) 0%, transparent 45%)',
          }}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
            {grouped.map((run, runIdx) => {
              const head = run[0]!;
              const isAgent = head.sender_type === 'agent';
              const isNote = isAgent && head.is_internal_note;
              const last = run[run.length - 1]!;
              const senderLabel = isAgent
                ? isNote
                  ? t('conversation.internalNote')
                  : t('conversation.you', { defaultValue: 'You' })
                : contactName;
              const time = formatRelative(last.date_created);

              return (
                <div
                  key={runIdx}
                  className={cn('flex gap-2.5', isAgent ? 'flex-row-reverse text-end' : 'flex-row')}
                >
                  <Avatar
                    name={isAgent ? 'You' : c?.contact?.name}
                    email={isAgent ? undefined : c?.contact?.email}
                    size="sm"
                    className={cn(isAgent && isNote && 'ring-2 ring-warning/40 ring-offset-1')}
                  />
                  <div
                    className={cn(
                      'flex max-w-[78%] min-w-0 flex-col gap-1',
                      isAgent && 'items-end',
                    )}
                  >
                    <div className="flex items-baseline gap-2 text-2xs">
                      <span className="font-medium text-foreground">{senderLabel}</span>
                      <span className="text-muted-foreground tabular-nums">{time}</span>
                    </div>
                    <div className={cn('flex flex-col gap-0.5', isAgent && 'items-end')}>
                      {run.map((m, i) => {
                        const isLast = i === run.length - 1;
                        return (
                          <div
                            key={m.id}
                            className={cn(
                              'px-3.5 py-2 text-sm leading-relaxed break-words text-start max-w-fit',
                              // No borders, no card chrome. Just bg + shape.
                              isNote
                                ? 'bg-warning/15 text-warning-foreground'
                                : isAgent
                                  ? 'bg-foreground text-background'
                                  : 'bg-secondary text-foreground',
                              // Smooth pill shape, tail only on the LAST bubble of a run.
                              'rounded-[18px]',
                              isLast && isAgent && 'rounded-ee-sm',
                              isLast && !isAgent && 'rounded-es-sm',
                            )}
                          >
                            <p className="whitespace-pre-wrap">{m.content}</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}

            {customerTyping && (
              <div className="flex gap-2.5">
                <Avatar name={c?.contact?.name} email={c?.contact?.email} size="sm" />
                <div className="rounded-[18px] rounded-es-sm bg-secondary px-3.5 py-2.5">
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
          <div className="mx-auto max-w-3xl px-5 pb-5 pt-3">
            {/* Tabs: reply / internal note (text-button style, no chip chrome) */}
            <div className="mb-1 flex items-center gap-4 text-xs">
              <button
                type="button"
                onClick={() => {
                  setInternalNote(false);
                  setMentionMenu(null);
                }}
                className={cn(
                  'relative h-8 font-medium transition-colors duration-fast ease-out',
                  !internalNote
                    ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('conversation.tab.reply', { defaultValue: 'Reply' })}
              </button>
              <button
                type="button"
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
                'ring-1 ring-foreground/[0.05]',
                internalNote ? 'bg-warning/10' : 'bg-card/70 backdrop-blur',
                'focus-within:bg-card focus-within:shadow-lg focus-within:shadow-foreground/[0.08] focus-within:ring-primary/30',
                internalNote && 'focus-within:ring-warning/50',
              )}
            >
              <textarea
                ref={draftRef}
                rows={1}
                className={cn(
                  'block w-full resize-none bg-transparent px-3 py-3 pe-14 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground',
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
                  if (e.key === 'Escape') setMentionMenu(null);
                }}
              />

              <button
                type="button"
                onClick={send}
                disabled={draft.trim().length === 0}
                aria-label={t('actions.send', { ns: 'common' })}
                className={cn(
                  'absolute end-2 bottom-2 inline-flex h-9 w-9 items-center justify-center rounded-full',
                  'transition-[transform,background-color,opacity] duration-fast ease-out',
                  'active:enabled:scale-95',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  internalNote
                    ? 'bg-warning text-warning-foreground'
                    : 'bg-foreground text-background hover:bg-foreground/90',
                )}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-4 w-4 rtl:scale-x-[-1]"
                  aria-hidden
                >
                  <path d="M1.6 13.7 14 8.4c.55-.23.55-1.01 0-1.24L1.6 1.86c-.55-.24-1.13.27-.94.85L2.3 7.32 8.5 8 2.3 8.68l-1.64 4.61c-.2.58.39 1.09.94.85Z" />
                </svg>
              </button>

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
              <kbd className="font-mono text-[10px]">Enter</kbd>{' '}
              {t('conversation.sendHint', { defaultValue: 'to send' })}
              {' · '}
              <kbd className="font-mono text-[10px]">Shift+Enter</kbd>{' '}
              {t('conversation.newlineHint', { defaultValue: 'for newline' })}
            </p>
          </div>
        </div>
      </div>

      {isDesktop ? (
        <ConversationSidebar
          conversationId={conversationId}
          notes={notes}
          onDeleteNote={deleteNote}
        />
      ) : (
        detailsOpen && (
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
            <div
              aria-hidden
              onClick={() => setDetailsOpen(false)}
              className="absolute inset-0 bg-foreground/30 backdrop-blur-sm motion-safe:animate-fade-in"
            />
            <div className="absolute inset-y-0 end-0 flex bg-card shadow-2xl shadow-foreground/20 motion-safe:animate-slide-in-drawer">
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
                onDeleteNote={deleteNote}
                className="w-[20rem] max-w-[85vw]"
              />
            </div>
          </div>
        )
      )}
    </div>
  );
}
