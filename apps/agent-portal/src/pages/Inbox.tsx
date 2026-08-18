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
  SectionCard,
  SelectMenu,
  Skeleton,
  StatCard,
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
  /* Whether ANYTHING is narrowing the list. Used to tell "there are none"
     apart from "none match", which is the difference between an empty inbox
     and an inbox that looks broken. */
  const anyFilterOn =
    (filters.status ?? 'all') !== 'all' ||
    (filters.priority ?? 'all') !== 'all' ||
    (filters.assignment ?? 'all') !== 'all' ||
    !!filters.search?.trim();

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
  // WhatsApp-style second line: the last real message, not a repeat of the
  // name/phone/email. "You:" prefixes agent replies; an image/file-only message
  // shows an attachment label. Shared by the list rows and the welcome pane's
  // Recent activity so both read the same.
  const previewFor = (id: string): string => {
    const pv = previews.data?.[id];
    if (!pv)
      return previews.isLoading
        ? ''
        : t('inbox.noMessagesYet', { defaultValue: 'No messages yet' });
    const body = pv.hasAttachment
      ? t('inbox.attachmentPreview', { defaultValue: 'Attachment' })
      : (pv.content ?? '');
    return pv.sender_type === 'agent'
      ? `${t('inbox.youPrefix', { defaultValue: 'You:' })} ${body}`
      : body;
  };
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
            'relative flex shrink-0 flex-col overflow-hidden rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]',
            !isDesktop && 'w-full',
          )}
          style={isDesktop ? { width: list.width } : undefined}
        >
          {/* Header */}
          <div className="flex shrink-0 items-baseline gap-2 px-5 pt-5">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              {t('inbox.title')}
            </h2>
            <span className="rounded-md bg-secondary px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-muted-foreground ring-1 ring-inset ring-foreground/[0.06]">
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
              active = false,
            }: {
              label: string;
              value: number;
              tone: 'default' | 'pink' | 'primary';
              onClick?: () => void;
              /** This tile's filter is the one currently applied. */
              active?: boolean;
            }) => (
              // Boxed mini-tile with a status dot by the label — the KPI
              // grammar of the reference boards, shrunk to the list header.
              <button
                type="button"
                onClick={onClick}
                className={cn(
                  'flex flex-1 flex-col gap-0.5 rounded-xl bg-card px-2.5 py-2 text-start ring-1 ring-foreground/[0.06]',
                  'transition-[background-color,box-shadow] duration-fast ease-out',
                  'hover:bg-secondary/60 active:scale-[0.98]',
                  active && 'bg-primary/[0.08] ring-primary/40',
                )}
                aria-pressed={onClick ? active : undefined}
                title={
                  active
                    ? t('inbox.clearFilter', { defaultValue: 'Click again to clear this filter' })
                    : undefined
                }
              >
                <span
                  className={cn(
                    'text-lg font-extrabold tabular-nums tracking-[-0.03em]',
                    tone === 'pink' && 'text-magenta',
                    tone === 'primary' && 'text-primary',
                    tone === 'default' && 'text-foreground',
                  )}
                >
                  {value}
                </span>
                <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      tone === 'pink' && 'bg-magenta',
                      tone === 'primary' && 'bg-primary',
                      tone === 'default' && 'bg-success',
                    )}
                  />
                  <span className="truncate">{label}</span>
                </span>
              </button>
            );
            return (
              // px-4 so the tile rings share a start edge with the search field
              // below — three different left edges read as clutter in a 340px rail.
              <div className="mt-3 flex gap-1.5 px-4">
                <Stat
                  label={t('inbox.stats.open', { defaultValue: 'open' })}
                  value={openCount}
                  tone="default"
                  active={filters.status === 'open'}
                  onClick={() =>
                    setFilters((f) => ({ ...f, status: f.status === 'open' ? 'all' : 'open' }))
                  }
                />
                <Stat
                  label={t('inbox.stats.urgent', { defaultValue: 'urgent' })}
                  value={urgentCount}
                  tone="pink"
                  active={filters.priority === 'urgent'}
                  onClick={() =>
                    setFilters((f) => ({
                      ...f,
                      priority: f.priority === 'urgent' ? 'all' : 'urgent',
                    }))
                  }
                />
                <Stat
                  label={t('inbox.stats.unread', { defaultValue: 'unread' })}
                  value={unreadCount}
                  tone="primary"
                />
              </div>
            );
          })()}

          {/* Search + ghost filter row — mt-3 keeps the same breath between the
              stat tiles above and the search field as between title and tiles. */}
          <div className="mt-3 space-y-2 px-4 pb-3">
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
            {/* One quiet cluster, same anatomy as the conversation toolbar's
                property group, so the selects read as one filter control. */}
            <div className="flex flex-wrap items-center gap-0.5 rounded-xl bg-secondary/40 p-1 ring-1 ring-inset ring-foreground/[0.06]">
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

          {/* Bulk toolbar — pill-shaped, floats, no border bands. bg-primary/10,
              not bg-primary-subtle: that token embeds its own alpha, so the
              <alpha-value> expansion is invalid CSS and the fill paints NOTHING
              (the design-law token-alpha trap). Jade wash + jade hairline. */}
          {someChecked && (
            <div className="mx-4 mb-2 flex flex-wrap items-center gap-1.5 rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/20 px-3 py-2 text-xs animate-fade-in">
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
              <ul className="pt-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <li
                    key={i}
                    className="flex min-h-14 w-full items-center gap-3 border-b border-b-foreground/[0.06] px-4 last:border-b-0"
                  >
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
                {/* px-4 puts this checkbox on the same column as the row
                    checkboxes below (ms-4) — one aligned select rail. */}
                <label className="flex h-8 items-center gap-2 border-b border-b-foreground/[0.06] px-4 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked && !allChecked;
                    }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 rounded-md border-border-strong bg-input accent-primary"
                  />
                  {t('inbox.selectAll')}
                </label>
                <ul className="space-y-1.5 p-2">
                  {conversations.data.map((c) => {
                    const active = selected === c.id;
                    const unread = c.unread_count_agent > 0;
                    const displayName =
                      c.contact?.name ||
                      c.contact?.phone ||
                      c.contact?.email ||
                      t('inbox.unknownContact');
                    const previewText = previewFor(c.id);
                    return (
                      <li
                        key={c.id}
                        // Board table row: full-bleed, hairline bottom rule, a
                        // 2px start accent when active. Side-scoped border
                        // colors (border-b-* / border-s-*) so the two edges
                        // never fight — cn() is a plain joiner, not a merger.
                        className={cn(
                          // Cards, not ruled rows — see TicketsPage for why.
                          'group relative flex min-h-14 items-stretch rounded-2xl transition-[background-color,box-shadow] duration-base ease-out',
                          active
                            ? 'bg-primary/10 shadow-[0_6px_18px_-10px_oklch(var(--shadow-color)/0.5)] ring-1 ring-inset ring-primary/25'
                            : unread
                              ? 'bg-card shadow-[0_2px_10px_-8px_oklch(var(--shadow-color)/0.4)] hover:shadow-[0_6px_18px_-10px_oklch(var(--shadow-color)/0.45)]'
                              : 'hover:bg-card hover:shadow-[0_4px_14px_-10px_oklch(var(--shadow-color)/0.45)]',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="ms-4 mt-4 h-3.5 w-3.5 rounded-md border-border-strong bg-card accent-primary opacity-0 group-hover:opacity-100 checked:opacity-100 transition-opacity duration-fast"
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
                          {/* Messenger row: hairline-ringed avatar, name + last
                              message line, accent time and an unread bubble. */}
                          <span
                            className={cn(
                              'shrink-0 rounded-full ring-1',
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
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span
                                  className={cn(
                                    'truncate text-sm',
                                    unread
                                      ? 'font-semibold text-foreground'
                                      : 'font-medium text-foreground/90',
                                  )}
                                >
                                  {displayName}
                                </span>
                                {/* Jade unread dot — glows on the dark canvas. */}
                                {unread && (
                                  <span
                                    aria-hidden
                                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60"
                                  />
                                )}
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
                  <h3 className="text-md font-semibold text-foreground">
                    {anyFilterOn
                      ? t('inbox.emptyFiltered', {
                          defaultValue: 'Nothing matches these filters.',
                        })
                      : t('inbox.empty')}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {anyFilterOn
                      ? t('inbox.emptyFilteredHint', {
                          defaultValue:
                            'Conversations are hidden, not gone. Clear the filters to see them.',
                        })
                      : t('inbox.emptyHint', {
                          defaultValue:
                            'New conversations from your widget land here in real time.',
                        })}
                  </p>
                </div>
                {anyFilterOn && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        status: 'all',
                        priority: 'all',
                        assignment: 'all',
                        query: '',
                      }))
                    }
                  >
                    {t('inbox.clearFilters', { defaultValue: 'Clear filters' })}
                  </Button>
                )}
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
              const waiting = [...all]
                .filter((c) => c.status === 'open')
                .sort((a, b) => (a.last_message_at ?? '').localeCompare(b.last_message_at ?? ''))
                .slice(0, 5);
              return (
                <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-5 p-6">
                  {/* The agent's morning glance, on the brand sweep the admin
                      Overview opens with — the same welcome language in both
                      portals. White ink: the fill is saturated in both themes. */}
                  <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-primary via-[oklch(0.66_0.13_190)] to-sky p-6 shadow-float motion-safe:animate-rise-in">
                    <div
                      aria-hidden
                      className="absolute inset-0 bg-[radial-gradient(ellipse_60%_120%_at_85%_-20%,rgb(255_255_255/0.25),transparent_60%)]"
                    />
                    <h2 className="relative font-display text-3xl font-extrabold leading-[1.25] tracking-[-0.03em] text-balance text-white">
                      {openCount === 0
                        ? `${t('inbox.welcome.zeroTitle')} ${t('inbox.welcome.zeroAccent')}`
                        : `${t('inbox.welcome.waiting', { count: openCount })} ${
                            urgentCount > 0
                              ? t('inbox.welcome.urgentAccent', { count: urgentCount })
                              : t('inbox.welcome.pace')
                          }`}
                    </h2>
                    <p className="relative mt-2 max-w-prose text-sm text-white/85">
                      {t('inbox.welcomeHint', {
                        defaultValue:
                          'Pick the next thread on the left, or filter by what needs attention first.',
                      })}
                    </p>
                  </div>

                  {/* Board KPI tiles — the shared StatCard anatomy: hero numeral,
                      tinted icon chip, uppercase micro-label. Urgent is magenta
                      to match the list strip's urgent numeral (one number, one
                      hue everywhere); unread is jade to match the list's unread
                      dot. Colour stays an accent, never a surface fill. */}
                  <div className="grid grid-cols-3 gap-3">
                    <StatCard
                      label={t('inbox.stats.open', { defaultValue: 'open' })}
                      value={openCount}
                      tone="success"
                      icon={
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                          aria-hidden
                        >
                          <path d="M13.5 7.5a5.5 5.5 0 0 1-8.03 4.9L2.5 13.5l1.03-3A5.5 5.5 0 1 1 13.5 7.5Z" />
                        </svg>
                      }
                    />
                    <StatCard
                      label={t('inbox.stats.urgent', { defaultValue: 'urgent' })}
                      value={urgentCount}
                      tone="pink"
                      icon={
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                          aria-hidden
                        >
                          <path d="M8.9 1.8 3.8 9h3.1l-.8 5.2L11.2 7H8.1l.8-5.2Z" />
                        </svg>
                      }
                    />
                    <StatCard
                      label={t('inbox.stats.unread', { defaultValue: 'unread' })}
                      value={unreadCount}
                      tone="primary"
                      icon={
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-4 w-4"
                          aria-hidden
                        >
                          <path d="M12.6 11.2H3.4c.9-1 1.35-2.5 1.35-4.45a3.25 3.25 0 0 1 6.5 0c0 1.95.45 3.45 1.35 4.45Z" />
                          <path d="M6.7 13.2a1.45 1.45 0 0 0 2.6 0" />
                        </svg>
                      }
                    />
                  </div>

                  {/* Oldest-waiting, not most-recent: the rail beside this is
                      already sorted newest-first, so repeating it here was a
                      mirror. What an agent cannot see there is who has been
                      waiting longest, which is where to start. */}
                  {waiting.length > 0 ? (
                    <SectionCard
                      title={t('inbox.welcome.waitingLongest', {
                        defaultValue: 'Waiting longest',
                      })}
                    >
                      <ul className="divide-y divide-foreground/[0.06]">
                        {waiting.map((c) => {
                          const name =
                            c.contact?.name ||
                            c.contact?.phone ||
                            c.contact?.email ||
                            t('inbox.unknownContact');
                          // Same last-message line as the inbox list — without
                          // it each row is a name and a void of unused width.
                          const preview = previewFor(c.id);
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => setSelected(c.id)}
                                className="group flex w-full items-center gap-3 rounded-lg px-1 py-2.5 text-start transition-colors duration-fast ease-out hover:bg-foreground/[0.04]"
                              >
                                <Avatar
                                  name={c.contact?.name}
                                  email={c.contact?.email}
                                  phone={c.contact?.phone}
                                  size="md"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-semibold text-foreground">
                                    {name}
                                  </span>
                                  {preview && (
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                      {preview}
                                    </span>
                                  )}
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
                    </SectionCard>
                  ) : (
                    <div className="flex items-center gap-4 rounded-2xl bg-card p-6 shadow-soft ring-1 ring-foreground/[0.06]">
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
