import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Button,
  cn,
  ConversationPlaceholderArt,
  ErrorState,
  formatRelative,
  GhostSelect,
  InboxEmptyArt,
  Pill,
  ResizeHandle,
  SelectMenu,
  Skeleton,
  toast,
  useIsDesktop,
  useResizable,
} from '@yiji/ui';
import { SOCKET_EVENTS, type ConversationStatus, type Priority } from '@yiji/shared-types';
import {
  conversationIdsForOrder,
  useConversations,
  useConversationPreviews,
  useUpdateConversation,
  useAddTagToConversation,
  usePrefetchInboxOrders,
  useTags,
  type InboxFilters,
} from '../features/inbox/api.js';
import { ConversationView } from '../features/conversation/ConversationView.js';
import { useAuth } from '../lib/auth/AuthContext.js';
import { getSocket } from '../lib/socket.js';

const STATUSES: ConversationStatus[] = ['open', 'solved'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

const STATUS_TONE: Record<ConversationStatus, 'success' | 'primary'> = {
  open: 'success',
  solved: 'primary',
};

async function broadcast(conversationId: string): Promise<void> {
  const socket = await getSocket();
  socket.emit(SOCKET_EVENTS.conversationUpdated, { conversationId });
}

export function Inbox() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isDesktop = useIsDesktop();
  const list = useResizable({
    storageKey: 'yiji.agent.inboxWidth',
    defaultWidth: 340,
    min: 288,
    max: 480,
  });
  const { user } = useAuth();
  /**
   * A manager sees everything; an agent sees their own work plus the unassigned
   * pool. `admin_access` is the authoritative signal — in Directus 11 admin is a
   * property of policies, not of the role's name, so matching on "Administrator"
   * would miss anyone granted it a different way.
   */
  const isManager = !!user?.admin_access;
  const [filters, setFilters] = useState<InboxFilters>({
    status: 'open',
    sort: 'recent',
    assignment: 'mine',
  });
  // Managers default to the whole inbox; agents to their own queue.
  useEffect(() => {
    setFilters((f) => ({ ...f, assignment: isManager ? 'all' : 'mine' }));
  }, [isManager]);
  // Order-id search runs as its own query because the order lives on the
  // ticket, not the conversation. Kept separate from the list query so a slow
  // or failed ticket lookup degrades to a name/phone search instead of
  // emptying the inbox.
  const orderTerm = (filters.search ?? '').trim();
  const orderMatches = useQuery({
    // `\d`, a DIGIT — this was `/d/`, the letter, so the lookup only ran for a
    // search containing the letter "d" and no order id in the system has one.
    // Every numeric search silently skipped the fallback and the agent was told
    // the chat did not exist.
    enabled: /\d/.test(orderTerm),
    queryKey: ['conversations-by-order', orderTerm],
    staleTime: 30_000,
    queryFn: () => conversationIdsForOrder(orderTerm),
  });
  const conversations = useConversations({
    ...filters,
    orderConversationIds: orderMatches.data ?? [],
    currentUserId: user?.id,
    // So a chat handed to this agent's SHIFT shows up in "mine", not only in
    // "all conversations" where nobody working a queue is looking.
    currentTeamId: user?.team ?? null,
  });
  const previews = useConversationPreviews((conversations.data ?? []).map((c) => c.id));
  const tags = useTags();
  const prefetchOrders = usePrefetchInboxOrders();
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Deep-link support: /?conv=<id> opens that conversation (used by the
  // command palette and AI semantic-search results).
  const [searchParams] = useSearchParams();
  const convParam = searchParams.get('conv');
  useEffect(() => {
    if (convParam) setSelected(convParam);
  }, [convParam]);
  const update = useUpdateConversation();
  const addTag = useAddTagToConversation();

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      const onActivity = () => {
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        // Keep the WhatsApp-style last-message previews fresh in real time.
        void qc.invalidateQueries({ queryKey: ['conversation-previews'] });
      };
      socket.on(SOCKET_EVENTS.inboxActivity, onActivity);
      cleanup = () => socket.off(SOCKET_EVENTS.inboxActivity, onActivity);
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [qc]);

  useEffect(() => setChecked(new Set()), [filters]);

  const allIds = useMemo(
    () => new Set((conversations.data ?? []).map((c) => c.id)),
    [conversations.data],
  );
  const allChecked = checked.size > 0 && checked.size === allIds.size;
  const someChecked = checked.size > 0;

  const toggleOne = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(allIds));

  const bulkSetStatus = async (status: ConversationStatus) => {
    const ids = [...checked];
    try {
      await Promise.all(ids.map((id) => update.mutateAsync({ id, patch: { status } })));
      await Promise.all(ids.map(broadcast));
      setChecked(new Set());
      toast.success(t('inbox.bulkStatusDone', { count: ids.length }));
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };
  const bulkAddTag = async (tagId: string) => {
    const ids = [...checked];
    try {
      await Promise.all(ids.map((id) => addTag.mutateAsync({ conversationId: id, tagId })));
      await Promise.all(ids.map(broadcast));
      setChecked(new Set());
      toast.success(t('inbox.bulkTagDone', { count: ids.length }));
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

  const statusDisplay =
    filters.status && filters.status !== 'all'
      ? t(`status.${filters.status}`, { ns: 'common' })
      : t('inbox.allStatuses');
  const priorityDisplay =
    filters.priority && filters.priority !== 'all'
      ? t(`priority.${filters.priority}`, { ns: 'common' })
      : t('inbox.allPriorities');
  const sortDisplay = t(
    `inbox.sort${(filters.sort ?? 'recent').charAt(0).toUpperCase()}${(filters.sort ?? 'recent').slice(1)}`,
    { defaultValue: filters.sort ?? 'recent' },
  );

  // Single-column on mobile: the list and the conversation view swap places.
  // On desktop they sit side by side.
  const showList = isDesktop || selected === null;
  const showConversation = isDesktop || selected !== null;

  return (
    <div className="flex h-full gap-3 p-3">
      {showList && (
        <aside
          className={cn(
            'relative flex shrink-0 flex-col overflow-hidden rounded-2xl bg-card shadow-soft',
            !isDesktop && 'w-full',
          )}
          style={isDesktop ? { width: list.width } : undefined}
        >
          {/* Header */}
          <div className="flex shrink-0 items-baseline gap-2 px-5 pt-5">
            <h2 className="text-xl font-bold tracking-tight text-foreground">{t('inbox.title')}</h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {conversations.data?.length ?? 0}
            </span>
          </div>

          {/* Stats strip — quick glance at what's burning. Clickable to filter. */}
          {(() => {
            const all = conversations.data ?? [];
            const openCount = all.filter((c) => c.status === 'open').length;
            const urgentCount = all.filter((c) => c.priority === 'urgent').length;
            const unreadCount = all.filter((c) => c.unread_count_agent > 0).length;
            const Stat = ({
              label,
              value,
              tone,
              onClick,
            }: {
              label: string;
              value: number;
              tone: 'default' | 'pink' | 'primary';
              onClick?: () => void;
            }) => (
              <button
                type="button"
                onClick={onClick}
                className={cn(
                  'flex flex-1 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start transition-colors duration-fast ease-out',
                  'hover:bg-secondary/70 active:scale-[0.98]',
                )}
              >
                <span
                  className={cn(
                    'text-lg font-bold tabular-nums',
                    tone === 'pink' && 'text-magenta',
                    tone === 'primary' && 'text-primary',
                    tone === 'default' && 'text-foreground',
                  )}
                >
                  {value}
                </span>
                <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                  {label}
                </span>
              </button>
            );
            return (
              <div className="mt-2 flex gap-0.5 px-3">
                <Stat
                  label={t('inbox.stats.open', { defaultValue: 'open' })}
                  value={openCount}
                  tone="default"
                  onClick={() => setFilters((f) => ({ ...f, status: 'open' }))}
                />
                <Stat
                  label={t('inbox.stats.urgent', { defaultValue: 'urgent' })}
                  value={urgentCount}
                  tone="pink"
                  onClick={() => setFilters((f) => ({ ...f, priority: 'urgent' }))}
                />
                <Stat
                  label={t('inbox.stats.unread', { defaultValue: 'unread' })}
                  value={unreadCount}
                  tone="primary"
                />
              </div>
            );
          })()}

          {/* Search + ghost filter row */}
          <div className="space-y-2 px-4 pb-3">
            <div className="relative">
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              >
                <circle cx="7" cy="7" r="4.5" />
                <path d="m10.5 10.5 3 3" />
              </svg>
              <input
                type="search"
                aria-label={t('inbox.search')}
                placeholder={t('inbox.search')}
                className="block h-9 w-full rounded-full border-none bg-secondary/50 ps-9 pe-3 text-sm text-foreground ring-1 ring-inset ring-foreground/10 placeholder:text-muted-foreground focus:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 text-start transition-[background-color,box-shadow] duration-fast ease-out"
                value={filters.search ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              />
            </div>
            <div className="flex flex-wrap items-center gap-0.5">
              {/* Whose queue. Shown to everyone: a manager needs to narrow to
                  their own work, and an agent needs to reach the wider inbox to
                  pick up something the ladder released. */}
              <GhostSelect
                size="sm"
                value={filters.assignment ?? 'all'}
                display={
                  (filters.assignment ?? 'all') === 'mine'
                    ? t('inbox.assignedMine', { defaultValue: 'My queue' })
                    : t('inbox.assignedAll', { defaultValue: 'All conversations' })
                }
                aria-label={t('inbox.assignedAll', { defaultValue: 'All conversations' })}
                onChange={(v) => setFilters((f) => ({ ...f, assignment: v as 'mine' | 'all' }))}
                options={[
                  { value: 'mine', label: t('inbox.assignedMine', { defaultValue: 'My queue' }) },
                  {
                    value: 'all',
                    label: t('inbox.assignedAll', { defaultValue: 'All conversations' }),
                  },
                ]}
              />
              <GhostSelect
                size="sm"
                value={filters.status ?? 'all'}
                display={statusDisplay}
                aria-label={t('inbox.allStatuses')}
                onChange={(v) =>
                  setFilters((f) => ({ ...f, status: v as ConversationStatus | 'all' }))
                }
                options={[
                  { value: 'all', label: t('inbox.allStatuses') },
                  ...STATUSES.map((s) => ({
                    value: s,
                    label: t(`status.${s}`, { ns: 'common' }),
                  })),
                ]}
              />
              <GhostSelect
                size="sm"
                value={filters.priority ?? 'all'}
                display={priorityDisplay}
                aria-label={t('inbox.allPriorities')}
                onChange={(v) => setFilters((f) => ({ ...f, priority: v as Priority | 'all' }))}
                options={[
                  { value: 'all', label: t('inbox.allPriorities') },
                  ...PRIORITIES.map((p) => ({
                    value: p,
                    label: t(`priority.${p}`, { ns: 'common' }),
                  })),
                ]}
              />
              <GhostSelect
                size="sm"
                value={filters.sort ?? 'recent'}
                display={sortDisplay}
                aria-label={t('inbox.sort', { defaultValue: 'Sort' })}
                onChange={(v) => setFilters((f) => ({ ...f, sort: v as InboxFilters['sort'] }))}
                options={[
                  { value: 'recent', label: t('inbox.sortRecent') },
                  { value: 'oldest', label: t('inbox.sortOldest') },
                  { value: 'priority', label: t('inbox.sortPriority') },
                ]}
              />
            </div>
          </div>

          {/* Bulk toolbar — pill-shaped, floats, no border bands. */}
          {someChecked && (
            <div className="mx-4 mb-2 flex flex-wrap items-center gap-1.5 rounded-xl bg-primary-subtle px-3 py-2 text-xs animate-fade-in">
              <span className="font-semibold text-primary">
                {t('inbox.bulkSelected', { count: checked.size })}
              </span>
              <SelectMenu
                size="sm"
                value=""
                placeholder={t('inbox.bulkSetStatus')}
                aria-label={t('inbox.bulkSetStatus')}
                className="bg-card/80"
                onChange={(v) => {
                  if (v) void bulkSetStatus(v as ConversationStatus);
                }}
                options={STATUSES.map((s) => ({
                  value: s,
                  label: t(`status.${s}`, { ns: 'common' }),
                }))}
              />
              <SelectMenu
                size="sm"
                value=""
                placeholder={t('inbox.bulkAddTag')}
                aria-label={t('inbox.bulkAddTag')}
                className="bg-card/80"
                onChange={(v) => {
                  if (v) void bulkAddTag(v);
                }}
                options={(tags.data ?? []).map((tg) => ({ value: tg.id, label: tg.name }))}
              />
              <Button
                variant="ghost"
                size="sm"
                className="ms-auto h-7 px-2 text-xs"
                onClick={() => setChecked(new Set())}
              >
                {t('inbox.bulkClear')}
              </Button>
            </div>
          )}

          {/* List — no borders between rows; hover bg + active bg do the work. */}
          <div className="flex-1 overflow-auto">
            {conversations.isError ? (
              <ErrorState
                title={t('inbox.loadError', { defaultValue: 'Could not load conversations' })}
                message={t('inbox.loadErrorHint', {
                  defaultValue: 'Check your connection and try again.',
                })}
                retryLabel={t('actions.retry', { ns: 'common', defaultValue: 'Retry' })}
                onRetry={() => void conversations.refetch()}
              />
            ) : conversations.isLoading ? (
              <ul className="px-2 pt-2 space-y-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <li key={i} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5">
                    <Skeleton className="h-7 w-7 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3.5 w-14 rounded-full" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : conversations.data && conversations.data.length > 0 ? (
              <>
                <label className="flex h-7 items-center gap-2 px-5 text-2xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked && !allChecked;
                    }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 rounded-sm border-border-strong bg-input accent-primary"
                  />
                  {t('inbox.selectAll')}
                </label>
                <ul className="space-y-1.5 px-2 pb-2">
                  {conversations.data.map((c) => {
                    const active = selected === c.id;
                    const unread = c.unread_count_agent > 0;
                    const displayName =
                      c.contact?.name ||
                      c.contact?.phone ||
                      c.contact?.email ||
                      t('inbox.unknownContact');
                    // WhatsApp-style second line: the last real message, not a
                    // repeat of the name/phone/email. "You:" prefixes agent
                    // replies; an image/file-only message shows an attachment label.
                    const pv = previews.data?.[c.id];
                    const pvBody = pv?.hasAttachment
                      ? t('inbox.attachmentPreview', { defaultValue: 'Attachment' })
                      : (pv?.content ?? '');
                    const previewText = pv
                      ? pv.sender_type === 'agent'
                        ? `${t('inbox.youPrefix', { defaultValue: 'You:' })} ${pvBody}`
                        : pvBody
                      : previews.isLoading
                        ? ''
                        : t('inbox.noMessagesYet', { defaultValue: 'No messages yet' });
                    return (
                      <li
                        key={c.id}
                        className={cn(
                          'group relative flex items-stretch rounded-2xl transition-colors duration-fast ease-out',
                          active
                            ? 'bg-primary/[0.1] ring-1 ring-primary/25'
                            : unread
                              ? 'bg-foreground/[0.04] hover:bg-foreground/[0.07]'
                              : 'hover:bg-foreground/[0.05]',
                        )}
                      >
                        {/* Active accent bar — solid, single accent. */}
                        {active && (
                          <span
                            aria-hidden
                            className="absolute inset-y-2.5 start-0 w-[3px] rounded-full bg-primary"
                          />
                        )}
                        <input
                          type="checkbox"
                          className="ms-3 mt-4 h-3.5 w-3.5 rounded-sm border-border-strong bg-card accent-primary opacity-0 group-hover:opacity-100 checked:opacity-100 transition-opacity duration-fast"
                          checked={checked.has(c.id)}
                          onChange={() => toggleOne(c.id)}
                          aria-label={displayName}
                        />
                        <button
                          type="button"
                          onClick={() => setSelected(c.id)}
                          // The pointer reaches the row a beat before the click
                          // does, and that beat is longer than the commerce
                          // call — so the order panel is already answered by
                          // the time it mounts. Focus too, for the keyboard.
                          onMouseEnter={() => prefetchOrders(c)}
                          onFocus={() => prefetchOrders(c)}
                          className="flex flex-1 items-center gap-3 px-3 py-3 text-start"
                        >
                          {/* Messenger row: ringed avatar, name + last-message
                              line, accent time and a gradient unread bubble. */}
                          <span
                            className={cn(
                              'shrink-0 rounded-full ring-2',
                              unread ? 'ring-primary/40' : 'ring-foreground/10',
                            )}
                          >
                            <Avatar
                              name={c.contact?.name}
                              email={c.contact?.email}
                              phone={c.contact?.phone}
                              size="md"
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span
                                className={cn(
                                  'truncate text-sm',
                                  unread
                                    ? 'font-bold text-foreground'
                                    : 'font-semibold text-foreground/90',
                                )}
                              >
                                {displayName}
                              </span>
                              <span
                                className={cn(
                                  'shrink-0 text-2xs tabular-nums',
                                  unread ? 'font-semibold text-primary' : 'text-muted-foreground',
                                )}
                              >
                                {formatRelative(c.last_message_at)}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2">
                              <span
                                className={cn(
                                  'min-w-0 flex-1 truncate text-xs',
                                  unread
                                    ? 'font-medium text-foreground/85'
                                    : 'text-muted-foreground',
                                )}
                              >
                                {previewText}
                              </span>
                              {(c.priority === 'urgent' || c.priority === 'high') && (
                                <Pill tone={c.priority === 'urgent' ? 'pink' : 'orange'} size="sm">
                                  {t(`priority.${c.priority}`, { ns: 'common' })}
                                </Pill>
                              )}
                              {unread && (
                                <span
                                  className="inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground tabular-nums"
                                  aria-label={`${c.unread_count_agent} unread`}
                                >
                                  {c.unread_count_agent}
                                </span>
                              )}
                            </div>
                            {c.tags && c.tags.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {c.tags.map((tg) =>
                                  tg.tags_id ? (
                                    <span
                                      key={tg.tags_id.id}
                                      className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                                      style={
                                        tg.tags_id.color
                                          ? {
                                              background: `${tg.tags_id.color}24`,
                                              color: tg.tags_id.color,
                                            }
                                          : undefined
                                      }
                                    >
                                      {tg.tags_id.name}
                                    </span>
                                  ) : null,
                                )}
                              </div>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 p-6 pt-12 text-center">
                <InboxEmptyArt size={160} />
                <div className="space-y-1">
                  <h3 className="text-md font-semibold text-foreground">{t('inbox.empty')}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t('inbox.emptyHint', {
                      defaultValue: 'New conversations from your widget land here in real time.',
                    })}
                  </p>
                </div>
              </div>
            )}
          </div>
          {isDesktop && (
            <ResizeHandle
              bind={list.bind}
              dragging={list.dragging}
              side="start"
              label={t('inbox.resizeList', { defaultValue: 'Resize conversation list' })}
            />
          )}
        </aside>
      )}

      {showConversation && (
        <section className="flex-1 min-w-0 overflow-hidden">
          {selected ? (
            <ConversationView conversationId={selected} onBack={() => setSelected(null)} />
          ) : (
            (() => {
              const all = conversations.data ?? [];
              const openCount = all.filter((c) => c.status === 'open').length;
              const urgentCount = all.filter((c) => c.priority === 'urgent').length;
              const unreadCount = all.filter((c) => c.unread_count_agent > 0).length;
              const recent = [...all]
                .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
                .slice(0, 5);
              return (
                <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-4 p-6">
                  {/* The agent's morning glance — clean, no gradient. */}
                  <div>
                    <h2 className="text-3xl font-extrabold leading-[1.05] tracking-[-0.035em] text-balance text-foreground">
                      {openCount === 0
                        ? `${t('inbox.welcome.zeroTitle')} ${t('inbox.welcome.zeroAccent')}`
                        : `${t('inbox.welcome.waiting', { count: openCount })} ${
                            urgentCount > 0
                              ? t('inbox.welcome.urgentAccent', { count: urgentCount })
                              : t('inbox.welcome.pace')
                          }`}
                    </h2>
                    <p className="mt-2 max-w-prose text-sm text-muted-foreground">
                      {t('inbox.welcomeHint', {
                        defaultValue:
                          'Pick the next thread on the left, or filter by what needs attention first.',
                      })}
                    </p>
                  </div>

                  {/* Colored stat tiles. */}
                  <div className="grid grid-cols-3 gap-4">
                    {(
                      [
                        {
                          key: 'open',
                          label: t('inbox.stats.open', { defaultValue: 'open' }),
                          value: openCount,
                          dot: 'bg-success',
                        },
                        {
                          key: 'urgent',
                          label: t('inbox.stats.urgent', { defaultValue: 'urgent' }),
                          value: urgentCount,
                          dot: 'bg-destructive',
                        },
                        {
                          key: 'unread',
                          label: t('inbox.stats.unread', { defaultValue: 'unread' }),
                          value: unreadCount,
                          dot: 'bg-sky',
                        },
                      ] as const
                    ).map((s) => (
                      <div
                        key={s.key}
                        // Colour as accent, not surface: white card, ink numeral,
                        // state dot. Solid fills here read as a toy dashboard.
                        className="rounded-3xl bg-card p-5 shadow-soft ring-1 ring-border"
                      >
                        <div className="text-4xl font-bold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                          {s.value}
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                          <span
                            aria-hidden
                            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.dot)}
                          />
                          {s.label}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Recent activity panel. */}
                  {recent.length > 0 ? (
                    <div className="rounded-3xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.04]">
                      <p className="mb-3 text-sm font-semibold tracking-tight text-foreground">
                        {t('inbox.welcome.recent')}
                      </p>
                      <ul className="space-y-1">
                        {recent.map((c) => {
                          const name =
                            c.contact?.name ||
                            c.contact?.phone ||
                            c.contact?.email ||
                            t('inbox.unknownContact');
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => setSelected(c.id)}
                                className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors duration-fast ease-out hover:bg-secondary/60"
                              >
                                <Avatar
                                  name={c.contact?.name}
                                  email={c.contact?.email}
                                  phone={c.contact?.phone}
                                  size="md"
                                />
                                <span className="flex-1 truncate text-sm font-semibold text-foreground">
                                  {name}
                                </span>
                                <Pill tone={STATUS_TONE[c.status]} size="sm">
                                  {t(`status.${c.status}`, { ns: 'common' })}
                                </Pill>
                                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                                  {formatRelative(c.last_message_at)}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 rounded-3xl bg-card p-6 shadow-soft ring-1 ring-foreground/[0.04]">
                      <ConversationPlaceholderArt size={96} />
                      <p className="max-w-xs text-sm text-muted-foreground">
                        {t('inbox.welcome.zeroArt')}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </section>
      )}
    </div>
  );
}
