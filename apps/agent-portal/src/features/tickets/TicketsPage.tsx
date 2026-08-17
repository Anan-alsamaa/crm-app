import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  Avatar,
  Button,
  ChevronDownIcon,
  CloseIcon,
  Input,
  MeterBar,
  Pill,
  SavedTick,
  SectionCard,
  SelectMenu,
  Skeleton,
  Spinner,
  TicketEmptyArt,
  Toolbar,
  ToolbarSpacer,
  cn,
  formatRelative,
  toast,
  useIsDesktop,
} from '@yiji/ui';
import {
  couponDiffers,
  isCouponRequested,
  splitCouponForApproval,
  type Priority,
  type TicketStatus,
} from '@yiji/shared-types';
import {
  useTicket,
  useTicketEvents,
  useUpdateTicket,
  useAddTicketNote,
  useAddTicketAttachment,
  useRemoveTicketAttachment,
  useConversationAttachments,
  useCanReadConversation,
  useAttachExistingFileToTicket,
  type ChatAttachment,
  type TicketRow,
} from './api.js';
import { useAgents, useTeamOptions } from '../inbox/api.js';
import { WhatsAppReply } from './WhatsAppReply.js';
import { ChangeHistory } from './ChangeHistory.js';
import { exportTicketWorkbook } from './export-ticket.js';
import {
  distinctValues,
  filterTickets,
  formatDuration,
  isEmptyFilter,
  joinComplaintStores,
  type TicketFilterCriteria,
} from '@yiji/reports';
import { useMyComplaints, type AgentComplaintRow } from '../complaints/api.js';
import { TicketAttachments } from './TicketAttachments.js';
import {
  ComplaintClassification,
  ComplaintResolution,
  StorePicker,
  complaintHasErrors,
  complaintPatch,
  optionLabel,
  storeLabel,
  toDateInput,
  type ComplaintValues,
} from './ComplaintFields.js';
import { useStoreIndex, useStores } from './useStoreMatch.js';
import {
  LegacyOrderSnapshotCard,
  OrderSnapshotCard,
  parseLegacyOrderBlock,
} from './OrderSnapshotCard.js';
import { useContact } from '../contacts/api.js';
import { CustomFieldsSection } from '../custom-fields/CustomFieldsSection.js';
import { resolveMentions } from '../conversation/mentions.js';
import { useRequestCouponApproval } from '../coupons/api.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { formatBytes, isImage, isUnknownType } from '../../lib/files.js';
import { FileGlyph } from '../../components/FileGlyph.js';
import { useAssetBlobUrl } from '../../lib/useAssetBlobUrl.js';

const STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

type TicketFilter = 'all' | TicketStatus | 'overdue';
const FILTERS: TicketFilter[] = ['all', 'new', 'open', 'pending', 'resolved', 'overdue'];

/** Ticket status -> dot colour. Same hue ladder as the detail's status pill. */
const STATUS_DOT: Record<string, string> = {
  new: 'bg-sky',
  open: 'bg-primary',
  pending: 'bg-warning',
  resolved: 'bg-success',
  closed: 'bg-muted-foreground/40',
};

export function TicketsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Single-column below the desktop breakpoint: the list and the detail swap
  // places rather than shrinking the rail to something unreadable.
  const isDesktop = useIsDesktop();
  const agentName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() ||
    user?.email ||
    t('complaints.you', { defaultValue: 'You' });
  // No date window: a range here would quietly hide older tickets an agent
  // still has to work. The export names itself accordingly.
  const complaints = useMyComplaints(null, agentName);
  const { index: storeIndex } = useStoreIndex();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<TicketFilter>('all');
  const [criteria, setCriteria] = useState<TicketFilterCriteria>({});
  /* The rail's job is showing tickets. Filters are set once and then left, so
     they fold away and report how many are on rather than occupying four rows
     of the queue permanently. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [criteria.complaintType, criteria.from, criteria.to].filter(
    (v) => v != null && v !== '',
  ).length;

  // Deep-link support: open a specific ticket from /tickets?id=<id> (command
  // palette, AI search) or /tickets/<id> (notification "View" links).
  const { ticketId: pathTicketId } = useParams();
  const [searchParams] = useSearchParams();
  const deepLinkId = pathTicketId ?? searchParams.get('id');
  useEffect(() => {
    if (deepLinkId) setSelected(deepLinkId);
  }, [deepLinkId]);

  const isOverdue = (r: AgentComplaintRow) =>
    !r.firstRespondedAt &&
    r.firstResponseDueAt !== null &&
    new Date(r.firstResponseDueAt).getTime() < Date.now();

  // Branch attribution runs through the SAME join as the manager's report, so
  // one complaint is attributed to one branch whoever is looking at it.
  const list = useMemo<AgentComplaintRow[]>(
    () => joinComplaintStores(complaints.data ?? [], storeIndex) as AgentComplaintRow[],
    [complaints.data, storeIndex],
  );
  const stats = useMemo(() => {
    const open = list.filter(
      (r) => r.complaintStatus === 'open' || r.complaintStatus === 'new',
    ).length;
    const pending = list.filter((r) => r.complaintStatus === 'pending').length;
    const overdue = list.filter(isOverdue).length;
    // `date` is already the row's LOCAL calendar day, so comparing strings
    // avoids re-deriving a timezone the report has settled already.
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const todayKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const today = list.filter((r) => r.date === todayKey).length;
    return { open, pending, overdue, today };
  }, [list]);

  // The search runs over the SAME filter the manager's report uses, so "find
  // order 946641" behaves identically on both sides of the product.
  const searched = useMemo(() => filterTickets(list, criteria), [list, criteria]);
  const typesInRange = useMemo(() => distinctValues(list, 'complaintType'), [list]);

  const filtered = useMemo(() => {
    if (filter === 'all') return searched;
    if (filter === 'overdue') return searched.filter(isOverdue);
    return searched.filter((r) => r.complaintStatus === filter);
  }, [searched, filter]);

  const filterCount = (f: TicketFilter) => {
    if (f === 'all') return list.length;
    if (f === 'overdue') return stats.overdue;
    return list.filter((r) => r.complaintStatus === f).length;
  };

  return (
    <div className="flex h-full flex-col">
      {/* Dense toolbar: title + inline filter tabs (also stand in as stats) */}
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('tickets.title')}
        </h1>
        <span className="opacity-30 text-xs text-muted-foreground hidden sm:inline">·</span>
        <div className="flex min-w-0 items-center gap-x-4 overflow-x-auto text-xs">
          {FILTERS.map((f) => {
            const active = filter === f;
            const count = filterCount(f);
            const tone =
              f === 'overdue'
                ? 'text-destructive'
                : f === 'pending'
                  ? 'text-warning-foreground'
                  : '';
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'group relative inline-flex items-center gap-1.5 h-12 transition-colors duration-fast ease-out focus-visible:outline-none',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="font-medium">
                  {f === 'all'
                    ? t('tickets.filterAll', { defaultValue: 'All' })
                    : f === 'overdue'
                      ? t('tickets.overdue', { defaultValue: 'Overdue' })
                      : t(`status.${f}`, { ns: 'common' })}
                </span>
                {/* The alarm hue only when there is something to be alarmed
                    about — "Overdue 0" in red is a false alarm on every visit. */}
                <span className={cn('tabular-nums text-2xs', !active && count > 0 && tone)}>
                  {count}
                </span>
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                  />
                )}
              </button>
            );
          })}
        </div>
        <ToolbarSpacer />
        <Button type="button" size="sm" onClick={() => navigate('/new-ticket')}>
          {t('tickets.newTicket', { defaultValue: '+ New ticket' })}
        </Button>
      </Toolbar>

      {/* List + detail, not a table. The 27-column operations report belongs to
          the manager's portal; an agent works one complaint at a time and needs
          to read the queue at a glance, which a horizontally-scrolling sheet
          does not give them. The branch join, the import and the deep links
          from 1dc649d and after all stay — only the presentation goes back.
          Single-column on mobile: list and detail swap places. */}
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        {(isDesktop || selected === null) && (
          <aside
            className={cn(
              'flex shrink-0 flex-col overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft',
              isDesktop ? 'w-[360px]' : 'w-full',
            )}
          >
            {/* Search over the queue. One text box for anything with a value
                in it — order number, phone, branch, or a word from what was
                written — because an agent holding a number should not first
                have to decide which kind of number it is. The type and the
                dates are separate because they are chosen, not typed. */}
            <div className="space-y-2 border-b border-border px-3 py-2.5">
              <Input
                value={criteria.query ?? ''}
                onChange={(e) => setCriteria((c) => ({ ...c, query: e.target.value }))}
                placeholder={t('tickets.searchPlaceholder', {
                  defaultValue: 'Order number, phone, branch…',
                })}
                aria-label={t('tickets.searchLabel', { defaultValue: 'Search tickets' })}
                className="h-9"
              />
              <button
                type="button"
                onClick={() => setFiltersOpen((v) => !v)}
                aria-expanded={filtersOpen}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-fast hover:text-foreground"
              >
                <span className="flex items-center gap-1.5">
                  {t('tickets.filters', { defaultValue: 'Filters' })}
                  {activeFilters > 0 && (
                    <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                      {activeFilters}
                    </span>
                  )}
                </span>
                <ChevronDownIcon
                  size={12}
                  className={cn('transition-transform duration-fast', filtersOpen && 'rotate-180')}
                />
              </button>
              {filtersOpen && (
                <>
                  <SelectMenu
                    size="sm"
                    className="w-full"
                    value={criteria.complaintType ?? ''}
                    onChange={(v) => setCriteria((c) => ({ ...c, complaintType: v }))}
                    aria-label={t('complaint.type', { defaultValue: 'Complaint type' })}
                    options={[
                      {
                        value: '',
                        label: t('tickets.anyType', { defaultValue: 'Any complaint type' }),
                      },
                      // From the data in range, not the full vocabulary: a menu of
                      // types this agent has never handled is a list to read past.
                      ...typesInRange.map((v) => ({ value: v, label: optionLabel(v) })),
                    ]}
                  />
                  {/* The dates carry visible micro-labels: two bare date boxes side
                  by side read as one range control with no way to tell which
                  end is which. Full-width halves, so the pair squares up with
                  the search box above instead of ending ragged mid-rail. */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="block space-y-1">
                      <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {t('performance.from', { defaultValue: 'From' })}
                      </span>
                      <Input
                        type="date"
                        value={criteria.from ?? ''}
                        onChange={(e) => setCriteria((c) => ({ ...c, from: e.target.value }))}
                        aria-label={t('performance.from', { defaultValue: 'From' })}
                        className="h-8 w-full text-xs"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="block text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {t('performance.to', { defaultValue: 'To' })}
                      </span>
                      <Input
                        type="date"
                        value={criteria.to ?? ''}
                        onChange={(e) => setCriteria((c) => ({ ...c, to: e.target.value }))}
                        aria-label={t('performance.to', { defaultValue: 'To' })}
                        className="h-8 w-full text-xs"
                      />
                    </label>
                  </div>
                </>
              )}
              {!isEmptyFilter(criteria) && (
                // Undo lives with the controls it undoes. The "what is the
                // queue showing" count moved to the rail's foot, which shows
                // it whether or not a filter is on — one count, one place.
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setCriteria({})}
                    className="h-7 rounded-lg px-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {t('tickets.clearSearch', { defaultValue: 'Clear' })}
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              {complaints.isLoading ? (
                <ul>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <li
                      key={i}
                      className="flex h-14 w-full items-center gap-3 border-b border-border/60 px-3.5"
                    >
                      <Skeleton className="h-9 w-9 rounded-full" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-3 w-3/4" />
                        <Skeleton className="h-2.5 w-1/2" />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : filtered.length > 0 ? (
                /* CARDS, not ruled rows. A bordered bar per ticket is what made
                   this list read as a spreadsheet from 2009; separated cards
                   with air between them read as a modern queue. */
                <ul className="divide-y divide-foreground/[0.06]">
                  {filtered.map((r) => {
                    const active = selected === r.id;
                    const overdue = isOverdue(r);
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(r.id)}
                          className={cn(
                            'group relative flex w-full items-center gap-3 px-4 py-3 text-start',
                            'transition-[background-color,box-shadow,transform] duration-base ease-out',
                            active
                              ? 'bg-primary/[0.07] before:absolute before:inset-y-0 before:start-0 before:w-[3px] before:rounded-e-full before:bg-primary'
                              : 'hover:bg-foreground/[0.03]',
                          )}
                        >
                          <span className="relative shrink-0">
                            <Avatar name={r.customerName} phone={r.customerMobile} size="md" />
                            <span
                              aria-hidden
                              title={t(`status.${r.complaintStatus}`, {
                                ns: 'common',
                                defaultValue: r.complaintStatus,
                              })}
                              className={cn(
                                'absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-card',
                                STATUS_DOT[r.complaintStatus] ?? 'bg-muted-foreground/40',
                              )}
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-sm font-semibold text-foreground">
                                {r.subject}
                              </span>
                              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                                {r.date}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                                {/* The ops team scan by category the way they
                                    scan their own sheet, so the complaint type
                                    leads when there is one. */}
                                {r.complaintType && (
                                  <span className="font-medium text-foreground/70">
                                    {optionLabel(r.complaintType)}
                                    <span aria-hidden> · </span>
                                  </span>
                                )}
                                {r.customerName ||
                                  r.customerMobile ||
                                  t(`status.${r.complaintStatus}`, {
                                    ns: 'common',
                                    defaultValue: r.complaintStatus,
                                  })}
                                {/* Which branch this is against. It is the
                                    column the ops team reconcile on, and the
                                    denser row must not lose it. "Not mapped"
                                    is shown as itself so a gap stays visible. */}
                                {r.restaurantName && (
                                  <span className="text-muted-foreground/80">
                                    <span aria-hidden> · </span>
                                    {r.restaurantName}
                                    {r.city ? ` · ${r.city}` : ''}
                                  </span>
                                )}
                              </span>
                              {overdue && (
                                <Pill tone="destructive" size="sm">
                                  {t('tickets.overdue', { defaultValue: 'Overdue' })}
                                </Pill>
                              )}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="flex flex-col items-center gap-4 p-6 pt-12 text-center">
                  <TicketEmptyArt size={160} />
                  <div className="space-y-1">
                    <h3 className="text-md font-semibold text-foreground">{t('tickets.empty')}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t('tickets.emptyHint', {
                        defaultValue: 'Tickets are created from conversations that need follow-up.',
                      })}
                    </p>
                  </div>
                </div>
              )}
            </div>
            {/* Queue foot — pins the count to the rail's bottom edge, so a
                short queue ends in a deliberate hairline rather than trailing
                off into dead canvas. It also says what the queue is showing:
                without it a filtered list that happens to be short reads as
                "I have no tickets". */}
            {!complaints.isLoading && list.length > 0 && (
              <div className="flex h-9 shrink-0 items-center border-t border-border px-3.5 text-2xs tabular-nums text-muted-foreground">
                {t('tickets.searchCount', {
                  defaultValue: '{{shown}} of {{total}} tickets',
                  shown: filtered.length,
                  total: list.length,
                })}
              </div>
            )}
          </aside>
        )}

        {(isDesktop || selected !== null) && (
          <section
            className={cn(
              'min-w-0 flex-1 overflow-auto',
              // An OPEN ticket renders on the canvas so its SectionCards and
              // timing cards actually elevate — card-on-card at the same
              // lightness reads flat, which is the one thing the board look
              // cannot survive. The empty pane keeps the card chrome: a
              // composed empty state needs a surface to be composed on.
              selected === null && 'rounded-2xl bg-card ring-1 ring-foreground/[0.06] shadow-soft',
            )}
          >
            {selected ? (
              <TicketDetail
                ticketId={selected}
                onBack={() => {
                  setSelected(null);
                  if (deepLinkId) navigate('/tickets');
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="flex max-w-md flex-col items-center gap-5">
                  <TicketEmptyArt size={200} />
                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold tracking-tight text-display">
                      {t('tickets.selectPrompt', { defaultValue: 'Open a ticket' })}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {t('tickets.selectHint', {
                        defaultValue:
                          'Pick a ticket on the left to see its workflow, SLA timeline, and history.',
                      })}
                    </p>
                  </div>
                  {/* The pane's one affordance. Without it the only way out of
                      this dead space is the small button in the toolbar. */}
                  <Button type="button" size="md" onClick={() => navigate('/new-ticket')}>
                    {t('tickets.newTicket', { defaultValue: '+ New ticket' })}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * One selectable file from the linked chat. Images render a small thumbnail
 * (private asset fetched with the agent's token); everything else shows a
 * type glyph. "Add" links the existing Directus file onto the ticket.
 */
function ChatMediaRow({
  att,
  added,
  pending,
  onAdd,
}: {
  att: ChatAttachment;
  added: boolean;
  pending: boolean;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const showImg = isImage(att.type, att.filename) || isUnknownType(att.type, att.filename);
  const { url } = useAssetBlobUrl(att.id, showImg);
  const size = formatBytes(att.filesize);
  const sender =
    att.sender_type === 'customer'
      ? t('tickets.fromCustomer', { defaultValue: 'Customer' })
      : att.sender_type === 'agent'
        ? t('tickets.fromAgent', { defaultValue: 'Agent' })
        : t('tickets.fromSystem', { defaultValue: 'System' });

  return (
    // Inset on the dialog's card surface — bg-card here would vanish into it.
    <li className="flex items-center gap-2 rounded-lg bg-secondary/40 px-2 py-1.5 ring-1 ring-foreground/[0.04]">
      <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
        {showImg && url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <FileGlyph type={att.type} filename={att.filename} size="sm" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {att.filename ?? t('conversation.attachment', { defaultValue: 'Attachment' })}
        </span>
        <span className="block text-2xs text-muted-foreground">
          {sender}
          {size && ` · ${size}`}
        </span>
      </span>
      <button
        type="button"
        disabled={added || pending}
        onClick={onAdd}
        className={cn(
          'shrink-0 rounded-full border border-dashed px-2 py-0.5 text-2xs transition-colors duration-fast',
          added
            ? 'border-success/40 text-success'
            : 'border-border-strong text-muted-foreground hover:border-primary/50 hover:text-foreground',
          'disabled:cursor-default disabled:opacity-70',
        )}
      >
        {added
          ? t('tickets.added', { defaultValue: 'Added' })
          : t('tickets.addToTicket', { defaultValue: 'Add' })}
      </button>
    </li>
  );
}

/**
 * Modal picker for attaching files the customer (or agent) already shared in the
 * linked chat — the "add it later if it wasn't carried over at creation" flow.
 * Mirrors the app's overlay/scale-in dialog styling.
 */
function ChatMediaDialog({
  items,
  loading,
  visible,
  attachedFileIds,
  pending,
  onAdd,
  onClose,
}: {
  items: ChatAttachment[];
  loading: boolean;
  /** False when the chat is not this agent's to read — see useCanReadConversation. */
  visible: boolean;
  attachedFileIds: Set<string>;
  pending: boolean;
  onAdd: (fileId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-md animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-card p-6 shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
              {t('tickets.attachFromChat', { defaultValue: 'From chat' })}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('tickets.chatMediaHint', {
                defaultValue: 'Files shared in this conversation. Add any missing here.',
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('actions.close', { ns: 'common', defaultValue: 'Close' })}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-secondary hover:text-foreground"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner size={16} />
            </div>
          ) : items.length === 0 ? (
            /* "None" and "not yours to read" both arrive here as an empty list,
               because Directus answers a filtered read with 200 and no rows.
               Saying "no files shared" for a chat that was handed to another
               shift is a claim about the conversation made from no knowledge of
               it. */
            <p className="py-6 text-center text-sm text-muted-foreground">
              {visible
                ? t('tickets.noChatMedia', {
                    defaultValue: 'No files shared in this conversation.',
                  })
                : t('tickets.chatNotVisible', {
                    defaultValue:
                      'This chat is assigned to another agent, so its files are not shown here.',
                  })}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {items.map((att) => (
                <ChatMediaRow
                  key={att.id}
                  att={att}
                  added={attachedFileIds.has(att.id)}
                  pending={pending}
                  onAdd={() => onAdd(att.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            {t('actions.done', { ns: 'common', defaultValue: 'Done' })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TicketDetail({ ticketId, onBack }: { ticketId: string; onBack?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  // Excel export of one ticket is an administrator action, by request — the
  // file is operations paperwork, not part of an agent's queue work.
  const isAdmin = ['administrator', 'admin'].includes(me?.role?.name?.toLowerCase() ?? '');
  const ticket = useTicket(ticketId);
  const events = useTicketEvents(ticketId);
  const update = useUpdateTicket();
  const agents = useAgents();
  const teams = useTeamOptions();
  const addNote = useAddTicketNote();
  const addAttachment = useAddTicketAttachment();
  const removeAttachment = useRemoveTicketAttachment();
  const attachExisting = useAttachExistingFileToTicket();
  const chatMedia = useConversationAttachments(ticket.data?.conversation ?? null);
  // Whether this agent may read that chat at all — a ticket and its conversation
  // are scoped separately, so a handover can leave the two disagreeing.
  const chatVisible = useCanReadConversation(ticket.data?.conversation ?? null);
  // Legacy tickets (created before `order_snapshot`) carry the order as prose in
  // the description; recover the id so it can be re-fetched and rendered as a
  // proper card, and drop that block from the description we display.
  const legacyOrder = ticket.data?.order_snapshot
    ? null
    : parseLegacyOrderBlock(ticket.data?.description);
  const orderContact = useContact(ticket.data?.contact?.id ?? '');
  const orderVendorId = orderContact.data?.vendor?.yiji_vendor_id ?? null;
  const { user } = useAuth();
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showChatMedia, setShowChatMedia] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (ticket.isLoading)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );
  if (!ticket.data) return null;
  const tk = ticket.data;

  /**
   * The order id to re-fetch in full, if any: a legacy ticket that only stored
   * the order as prose, or a snapshot taken from the SUMMARY endpoint (no line
   * items, so no brand/restaurant either). Null when the stored snapshot is
   * already complete. Requires the contact's Yiji vendor id to look anything up.
   */
  const refetchOrderId = !orderVendorId
    ? null
    : (legacyOrder?.orderId ??
      (tk.order_snapshot && tk.order_snapshot.items.length === 0
        ? tk.order_snapshot.orderId
        : null));

  const patch = (p: Parameters<typeof update.mutateAsync>[0]['patch']) => {
    /*
     * Stamp the first response the first time anyone acts on this ticket.
     *
     * `first_responded_at` used to be set only by an agent replying in a
     * LINKED CHAT, so a complaint taken over the phone or typed straight into
     * the CRM never got one: 56 of 62 tickets had none, and the SLA report
     * could therefore only ever show a resolution figure for them. Working the
     * ticket at all IS the response. This records a floor ("no later than
     * this"), which beats a null that reads as "nobody ever answered".
     */
    const body = tk.first_responded_at ? p : { ...p, first_responded_at: new Date().toISOString() };
    return void update
      .mutateAsync({ id: tk.id, patch: body })
      .catch(() => toast.error(t('errors.updateFailed', { ns: 'common' })));
  };

  const submitNote = () => {
    const text = note.trim();
    if (!text || !user) return;
    const mentions = resolveMentions(text, agents.data ?? []);
    addNote
      .mutateAsync({ ticketId: tk.id, text, actorId: user.id, mentions })
      .then(() => setNote(''))
      .catch(() => toast.error(t('errors.updateFailed', { ns: 'common' })));
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await addAttachment.mutateAsync({ ticketId: tk.id, file });
      }
    } catch {
      toast.error(t('conversation.attachFailed', { defaultValue: 'Could not upload the file.' }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Files already shared in the linked chat — attachable without re-uploading,
  // for the case they weren't carried over when the ticket was created.
  const chatItems = chatMedia.data ?? [];
  const attachedFileIds = new Set(
    (tk.attachments ?? []).map((a) => a.file?.id).filter((id): id is string => Boolean(id)),
  );
  const addFromChat = (fileId: string) =>
    void attachExisting
      .mutateAsync({ ticketId: tk.id, fileId })
      .catch(() =>
        toast.error(t('conversation.attachFailed', { defaultValue: 'Could not attach the file.' })),
      );

  // Color only — SlaCard owns the weight. warning-foreground, not warning:
  // the warning hue is a light token and unreadable as text on light.
  const dueClass = (iso: string | null) => {
    if (!iso) return 'text-muted-foreground';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return 'text-destructive';
    if (ms < 30 * 60_000) return 'text-warning-foreground';
    return 'text-foreground';
  };

  // Board pill hues: arrivals sky, live work jade, waiting warning-treated,
  // finished success, closed neutral — one ladder shared with the list dots.
  const statusTone: Record<TicketStatus, 'blue' | 'primary' | 'warning' | 'success' | 'neutral'> = {
    new: 'blue',
    open: 'primary',
    pending: 'warning',
    resolved: 'success',
    closed: 'neutral',
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 sm:p-8">
      {/* Back to ticket list — mobile single-column only. */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md lg:hidden"
        >
          <ArrowLeftIcon size={15} className="rtl:-scale-x-100" />
          {t('tickets.backToList', { defaultValue: 'All tickets' })}
        </button>
      )}

      {/* Identity card — accent-ringed avatar + subject + contact + pills */}
      <header className="space-y-4">
        <div className="flex items-start gap-4">
          <span className="shrink-0 rounded-full bg-primary/30 p-[2px]">
            <span className="block rounded-full bg-background p-[2px]">
              <Avatar
                name={tk.contact?.name}
                email={tk.contact?.email}
                phone={tk.contact?.phone}
                size="lg"
              />
            </span>
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={statusTone[tk.status]} dot>
                {t(`status.${tk.status}`, { ns: 'common' })}
              </Pill>
              {tk.priority !== 'medium' && tk.priority !== 'low' && (
                <Pill tone={tk.priority === 'urgent' ? 'destructive' : 'orange'}>
                  {t(`priority.${tk.priority}`, { ns: 'common' })}
                </Pill>
              )}
            </div>
            <h2 className="text-2xl font-bold text-display tracking-[-0.02em] text-balance">
              {tk.subject}
            </h2>
            {/* Meta row in the board idiom: micro-labelled groups rather than a
                run-on sentence, with the two actions kept at the end. */}
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div className="min-w-0">
                <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('tickets.metaCustomer', { defaultValue: 'Customer' })}
                </div>
                <div className="mt-0.5 truncate text-xs font-medium text-foreground">
                  {tk.contact?.name ??
                    tk.contact?.phone ??
                    tk.contact?.email ??
                    t('inbox.unknownContact')}
                </div>
              </div>
              {tk.date_created && (
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('tickets.metaOpened', { defaultValue: 'Opened' })}
                  </div>
                  <div className="mt-0.5 text-xs font-semibold tabular-nums text-foreground">
                    {new Date(tk.date_created).toLocaleDateString()}
                  </div>
                </div>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() =>
                    exportTicketWorkbook(
                      tk,
                      (() => {
                        const a = agents.data?.find((x) => x.id === tk.assigned_agent);
                        return a?.first_name ?? a?.email ?? '';
                      })(),
                      {},
                    )
                  }
                  className="pb-px text-xs font-medium text-primary transition-colors duration-fast ease-out hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                >
                  {t('tickets.exportTicket', { defaultValue: 'Export to Excel' })}
                </button>
              )}
              {tk.conversation && (
                <>
                  {/* Only offered when the chat is actually this agent's to
                      open. A ticket and its conversation are scoped separately,
                      so a handover can leave the ticket owner without access —
                      and a link that lands on an empty inbox reads as a broken
                      app rather than as a permission boundary. */}
                  {chatVisible.data === false ? (
                    <span className="pb-px text-xs text-muted-foreground">
                      {t('tickets.conversationNotVisible', {
                        defaultValue: 'chat assigned to another agent',
                      })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigate(`/?conv=${tk.conversation}`)}
                      className="pb-px text-xs font-medium text-primary transition-colors duration-fast ease-out hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                    >
                      {t('tickets.viewConversation', { defaultValue: 'View conversation →' })}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* The agent's own words only — the order block is stripped out of
            legacy descriptions and rendered as a card below instead. */}
        {(legacyOrder ? legacyOrder.description : tk.description) && (
          <p className="max-w-prose whitespace-pre-wrap rounded-xl bg-secondary/50 px-4 py-3 text-sm leading-relaxed text-foreground/85 ring-1 ring-foreground/[0.04]">
            {legacyOrder ? legacyOrder.description : tk.description}
          </p>
        )}

        {/* The order this ticket was raised about — always a real order card.
            Re-fetch the full order when we only have the id (legacy prose
            tickets) or when the stored snapshot is thin: snapshots captured
            from the SUMMARY endpoint carry no line items / brand, so those
            tickets heal themselves instead of showing a half-empty card. */}
        {(tk.order_snapshot || (legacyOrder && orderVendorId)) && (
          <section className="max-w-prose space-y-2">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('tickets.orderSnapshotTitle', { defaultValue: 'Order from this chat' })}
            </h3>
            {/* Foldable, and folded is the useful default here: the header
                already says which order and for how much, and the agent came to
                this page for the notes and the history that the full card
                pushes off screen. */}
            {refetchOrderId ? (
              <LegacyOrderSnapshotCard
                vendorId={orderVendorId as string}
                orderId={refetchOrderId}
                collapsible
                defaultOpen={false}
              />
            ) : (
              <OrderSnapshotCard order={tk.order_snapshot!} collapsible defaultOpen={false} />
            )}
          </section>
        )}
      </header>

      {/* Two-column body: narrative (notes + history) on the left, ticket
          metadata/config in a rail on the right. order-swap keeps the source
          order (rail markup first) while the rail renders on the right at lg+. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Rail — properties, SLA, attachments. */}
        <aside className="space-y-5 lg:order-2">
          {/* Properties — stacked selects + the mark-responded CTA, on the
              shared SectionCard surface. */}
          <SectionCard title={t('tickets.properties', { defaultValue: 'Properties' })}>
            <div className="space-y-2.5">
              <label className="block space-y-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('conversation.status')}
                </span>
                <SelectMenu
                  size="sm"
                  fullWidth
                  value={tk.status}
                  aria-label={t('conversation.status')}
                  onChange={(next) => {
                    const extra: Record<string, string> = {};
                    if (next === 'resolved') extra.resolved_at = new Date().toISOString();
                    if (next === 'closed') extra.closed_at = new Date().toISOString();
                    patch({ status: next as TicketStatus, ...extra });
                  }}
                  options={STATUSES.map((s) => ({
                    value: s,
                    label: t(`status.${s}`, { ns: 'common' }),
                  }))}
                />
                {/* #7 — spell out the two terminal states so the agent knows which
                    one to pick and that neither is the same as logging a reply. */}
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t('tickets.statusHelp', {
                    defaultValue:
                      'Resolved = work done, awaiting the customer. Closed = finished for good.',
                  })}
                </p>
              </label>
              <label className="block space-y-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('conversation.priority')}
                </span>
                <SelectMenu
                  size="sm"
                  fullWidth
                  value={tk.priority}
                  aria-label={t('conversation.priority')}
                  onChange={(v) => patch({ priority: v as Priority })}
                  options={PRIORITIES.map((p) => ({
                    value: p,
                    label: t(`priority.${p}`, { ns: 'common' }),
                  }))}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('conversation.agent')}
                </span>
                <SelectMenu
                  size="sm"
                  fullWidth
                  value={tk.assigned_agent ?? ''}
                  aria-label={t('conversation.agent')}
                  onChange={(v) => patch({ assigned_agent: v || null })}
                  options={[
                    { value: '', label: t('conversation.unassigned') },
                    ...(agents.data ?? []).map((a) => ({
                      value: a.id,
                      label: a.first_name ?? a.email ?? '',
                    })),
                  ]}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('conversation.team')}
                </span>
                <SelectMenu
                  size="sm"
                  fullWidth
                  value={tk.assigned_team ?? ''}
                  aria-label={t('conversation.team')}
                  onChange={(v) => patch({ assigned_team: v || null })}
                  options={[
                    { value: '', label: t('conversation.noTeam') },
                    ...(teams.data ?? []).map((tm) => ({ value: tm.id, label: tm.name })),
                  ]}
                />
              </label>
            </div>
            {tk.status !== 'resolved' && tk.status !== 'closed' ? (
              <div className="mt-3 space-y-1.5 rounded-xl bg-secondary/40 p-3">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('tickets.solve', { defaultValue: 'Resolution' })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  fullWidth
                  onClick={() => {
                    const now = new Date().toISOString();
                    // A solved ticket that never recorded a first response
                    // makes the SLA report claim the agent never replied, and
                    // nothing else stamps that field. Backfilling it here is a
                    // floor, not a measurement: it says "no later than this",
                    // which beats a null that reads as "never".
                    patch({
                      status: 'resolved',
                      resolved_at: now,
                      ...(tk.first_responded_at ? {} : { first_responded_at: now }),
                    });
                  }}
                >
                  {t('tickets.markSolved', { defaultValue: 'Mark as solved' })}
                </Button>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t('tickets.markSolvedHint', {
                    defaultValue:
                      'Closes the work: sets the ticket to resolved and stops both SLA timers.',
                  })}
                </p>
                <WhatsAppReply ticket={tk} />
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-1.5 text-2xs font-medium text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
                {t('tickets.solvedAt', {
                  defaultValue: 'Solved · {{when}}',
                  when: formatRelative(tk.resolved_at ?? tk.first_responded_at),
                })}
              </div>
            )}
          </SectionCard>

          {/* Timings — how long the ticket took, and who touched it last.
              First response is deliberately NOT here: on a ticket it is a
              second clock nobody works to, and two deadlines in a narrow rail
              made the one that matters harder to find. It is still stamped, and
              still reported on, in the agent-performance report. */}
          <section className="space-y-2.5">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('tickets.timingsSection', { defaultValue: 'Timings' })}
            </h3>
            <div className="space-y-2">
              <SlaCard
                label={t('tickets.resolutionDue')}
                iso={tk.resolution_due_at}
                metAt={tk.resolved_at ?? null}
                created={tk.date_created}
                dueClass={dueClass}
                metLabel={t('tickets.resolvedAtLabel', { defaultValue: 'Resolved' })}
              />
              <ResolutionTimeCard created={tk.date_created} resolved={tk.resolved_at ?? null} />
              <LastTouchedCard by={tk.user_updated ?? null} at={tk.date_updated ?? null} />
            </div>
          </section>

          {/* Custom fields — admin-defined ticket attributes (FR-031). */}
          <section className="space-y-2.5">
            <CustomFieldsSection entityType="ticket" entityId={tk.id} />
          </section>
        </aside>

        {/* Main column — the ticket narrative: attachments + notes + history. */}
        <div className="min-w-0 space-y-6 lg:order-1">
          {/* Complaint detail — the ops team's own columns. Editable here as
              well as at creation because compensation is almost always decided
              AFTER the ticket is raised; a create-only form would mean the
              coupon columns stayed empty on exactly the tickets that had one. */}
          <TicketComplaintPanel ticket={tk} />

          {/* Attachments — front and center with live image previews, so the
              agent sees what was shared without clicking anything. On the
              shared SectionCard surface, with the two dashed attach actions in
              the card's own aside slot. */}
          <SectionCard
            title={
              <>
                {t('tickets.attachments', { defaultValue: 'Attachments' })}
                {tk.attachments && tk.attachments.length > 0 && (
                  <span className="ms-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary-subtle px-1.5 text-xs font-semibold tabular-nums text-primary">
                    {tk.attachments.length}
                  </span>
                )}
              </>
            }
            aside={
              <div className="flex items-center gap-2">
                {tk.conversation && chatItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowChatMedia(true)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3 text-xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:border-primary/50 hover:text-foreground"
                  >
                    <span>{t('tickets.attachFromChat', { defaultValue: 'From chat' })}</span>
                    <span className="tabular-nums opacity-70">{chatItems.length}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3 text-xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:border-primary/50 hover:text-foreground disabled:opacity-50"
                >
                  {uploading ? (
                    <Spinner size={13} />
                  ) : (
                    <>
                      <span className="text-sm leading-none">+</span>
                      <span>{t('tickets.attach', { defaultValue: 'Attach file' })}</span>
                    </>
                  )}
                </button>
              </div>
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => void onPickFiles(e.target.files)}
            />

            {/* Picker modal: files the customer (or agent) already shared in the
                chat — attach any that weren't carried over at creation. */}
            {showChatMedia && tk.conversation && (
              <ChatMediaDialog
                items={chatItems}
                loading={chatMedia.isLoading || chatVisible.isLoading}
                visible={chatVisible.data !== false}
                attachedFileIds={attachedFileIds}
                pending={attachExisting.isPending}
                onAdd={addFromChat}
                onClose={() => setShowChatMedia(false)}
              />
            )}

            {tk.attachments && tk.attachments.length > 0 ? (
              <TicketAttachments
                attachments={tk.attachments}
                onRemove={(junctionId) =>
                  void removeAttachment
                    .mutateAsync({ junctionId, ticketId: tk.id })
                    .catch(() => toast.error(t('errors.updateFailed', { ns: 'common' })))
                }
              />
            ) : (
              /* Composed placeholder, not a stray sentence: the dashed frame
                 marks out where files will land, in the same idiom as the
                 dashed attach buttons above it. */
              <p className="rounded-xl border border-dashed border-border-strong px-4 py-5 text-center text-xs text-muted-foreground">
                {t('tickets.noAttachments', { defaultValue: 'No attachments yet.' })}
              </p>
            )}
          </SectionCard>

          {/* Internal note composer — appends a 'commented' event to the history.
              The composer itself is an inset on the card (bg-secondary), not a
              second card: card-on-card at the same lightness reads flat. */}
          <SectionCard title={t('tickets.addNote', { defaultValue: 'Add internal note' })}>
            <div className="rounded-xl bg-secondary/40 p-2 ring-1 ring-foreground/[0.04] focus-within:ring-primary/30">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitNote();
                  }
                }}
                rows={2}
                placeholder={t('tickets.notePlaceholder', {
                  defaultValue: 'Leave a note for the team… @mention to notify',
                })}
                className="block w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <div className="flex items-center justify-end gap-2 px-1">
                <span className="me-auto text-2xs text-muted-foreground">
                  {t('conversation.mentionHint', { defaultValue: 'Type @ to mention a teammate' })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={!note.trim() || addNote.isPending}
                  onClick={submitNote}
                >
                  {t('tickets.addNoteCta', { defaultValue: 'Add note' })}
                </Button>
              </div>
            </div>
          </SectionCard>

          {/* Field changes — Directus's own revisions, so imports and raw API
              edits show here too, with the actor attached. Named for the
              question it answers: "Change history" and "History" side by side
              told nobody which held what. */}
          <SectionCard title={t('tickets.fieldHistory', { defaultValue: 'What changed' })}>
            <ChangeHistory ticketId={tk.id} />
          </SectionCard>

          {/* The worked timeline: notes, replies, assignments — what PEOPLE did,
              as opposed to which FIELDS moved above. */}
          <SectionCard title={t('tickets.activity', { defaultValue: 'Activity' })}>
            {events.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-2/3" />
                <Skeleton className="h-10 w-3/4" />
              </div>
            ) : events.data && events.data.length > 0 ? (
              <ol className="relative space-y-0">
                {/* Vertical connector */}
                <span aria-hidden className="absolute start-[7px] top-2 bottom-2 w-px bg-border" />
                {events.data.map((ev) => {
                  const isWarn = ev.event_type === 'sla_warning';
                  const isBreach = ev.event_type === 'sla_breached';
                  const tone = isBreach ? 'destructive' : isWarn ? 'warning' : 'primary';
                  const dotBg =
                    tone === 'destructive'
                      ? 'bg-destructive'
                      : tone === 'warning'
                        ? 'bg-warning'
                        : 'bg-primary';
                  const isComment = ev.event_type === 'commented';
                  const commentText =
                    isComment && ev.payload && typeof ev.payload.text === 'string'
                      ? (ev.payload.text as string)
                      : null;
                  const actorName =
                    ev.actor && typeof ev.actor === 'object'
                      ? (ev.actor.first_name ?? ev.actor.email ?? null)
                      : null;
                  return (
                    <li key={ev.id} className="relative flex items-start gap-3 py-2.5 ps-0">
                      {/* ring-card, not ring-background: the halo has to match
                          the surface the timeline sits on. */}
                      <span
                        className={cn(
                          'relative z-10 mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full ring-4 ring-card',
                          isComment ? 'bg-foreground/70' : dotBg,
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {isComment && actorName
                              ? actorName
                              : t(`tickets.event.${ev.event_type}`, {
                                  defaultValue: ev.event_type,
                                })}
                          </span>
                          <span className="text-2xs tabular-nums text-muted-foreground">
                            {ev.date_created ? new Date(ev.date_created).toLocaleString() : ''}
                          </span>
                        </div>
                        {commentText && (
                          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-secondary/60 px-3 py-2 text-sm leading-relaxed text-foreground">
                            {commentText}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              /* Same dashed frame as the attachments placeholder — an empty
                 timeline is a state of the section, not a floating sentence. */
              <p className="rounded-xl border border-dashed border-border-strong px-4 py-5 text-center text-xs text-muted-foreground">
                {t('tickets.noEvents')}
              </p>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

/**
 * The nine complaint columns on an existing ticket: a compact summary that
 * turns into the same fieldset the New Complaint form uses.
 *
 * Read-first by design. Most visits to a ticket are to look something up, and a
 * grid of filled-in inputs reads as "unsaved work" when it is really just
 * stored data. `Edit` swaps in the form; `Save` patches only what changed.
 */
function TicketComplaintPanel({ ticket }: { ticket: TicketRow }) {
  const { t } = useTranslation();
  const update = useUpdateTicket();
  const requestCoupon = useRequestCouponApproval();
  const { user } = useAuth();
  const stores = useStores();
  const [editing, setEditing] = useState(false);
  const [storeId, setStoreId] = useState(ticket.store ?? '');

  // Directus hands back numbers for the coupon columns and nulls for anything
  // unset; the form works in strings, so normalise on the way in.
  const stored: ComplaintValues = useMemo(
    () => ({
      complaint_date: toDateInput(ticket.complaint_date),
      complaint_type: ticket.complaint_type ?? '',
      service_type: ticket.service_type ?? '',
      complaint_source: ticket.complaint_source ?? '',
      communication_method: ticket.communication_method ?? '',
      response_desc: ticket.response_desc ?? '',
      compensation: ticket.compensation ?? '',
      coupon_code: ticket.coupon_code ?? '',
      coupon_value:
        ticket.coupon_value === null || ticket.coupon_value === undefined
          ? ''
          : String(ticket.coupon_value),
      coupon_percent:
        ticket.coupon_percent === null || ticket.coupon_percent === undefined
          ? ''
          : String(ticket.coupon_percent),
    }),
    [ticket],
  );
  const [draft, setDraft] = useState<ComplaintValues>(stored);

  // Re-sync when a different ticket is selected, or the row is refetched after
  // a save — without this the panel would show the previous ticket's answers.
  useEffect(() => {
    if (!editing) {
      setDraft(stored);
      setStoreId(ticket.store ?? '');
    }
  }, [stored, editing, ticket.store]);

  const branch = (stores.data ?? []).find((s) => s.id === ticket.store) ?? null;

  const rows: Array<[string, string]> = [
    [
      t('complaint.branch', { defaultValue: 'Restaurant / branch' }),
      branch ? storeLabel(branch) : '',
    ],
    [
      t('complaint.date', { defaultValue: 'Complaint date' }),
      stored.complaint_date ? stored.complaint_date.replace('T', ' ') : '',
    ],
    [t('complaint.type', { defaultValue: 'Complaint type' }), stored.complaint_type],
    [t('complaint.serviceType', { defaultValue: 'Service type' }), stored.service_type],
    [t('complaint.source', { defaultValue: 'Complaint source' }), stored.complaint_source],
    [
      t('complaint.communication', { defaultValue: 'Communication method' }),
      stored.communication_method,
    ],
    [t('complaint.compensation', { defaultValue: 'Compensation' }), stored.compensation],
    [t('complaint.couponCode', { defaultValue: 'Coupon code' }), stored.coupon_code],
    [
      t('complaint.couponValue', { defaultValue: 'Coupon value (SAR)' }),
      stored.coupon_value && `${stored.coupon_value} SAR`,
    ],
    [
      t('complaint.couponPercent', { defaultValue: 'Coupon %' }),
      stored.coupon_percent && `${stored.coupon_percent}%`,
    ],
  ].filter((r): r is [string, string] => !!r[1]);

  /**
   * Is the agent proposing a coupon that is not already on the ticket?
   *
   * Both the warning below and the save path key off this. The form is seeded
   * from the ticket, so "is a coupon present" (isCouponRequested) is true on
   * every visit to a ticket that already has one — it answers the wrong
   * question here.
   */
  const couponChanged = useMemo(
    () =>
      couponDiffers(draft, {
        coupon_code: ticket.coupon_code ?? null,
        coupon_value: ticket.coupon_value ?? null,
        coupon_percent: ticket.coupon_percent ?? null,
        compensation: ticket.compensation ?? null,
      }) && isCouponRequested(draft),
    [draft, ticket],
  );

  const save = async () => {
    if (complaintHasErrors(draft)) return;
    try {
      /**
       * The coupon goes to a supervisor, exactly as it does on the create
       * dialog — this path used to PATCH coupon_code / coupon_value /
       * coupon_percent straight onto the ticket, so an agent could grant
       * themselves any coupon by opening their own ticket and clicking Edit.
       * The approval queue was advisory: it only ever saw coupons raised from
       * the one screen that asked politely.
       *
       * Only a CHANGED coupon needs a supervisor. This form is seeded from the
       * ticket, so an already-approved coupon sits in these inputs on every
       * visit — sending it for approval again because somebody fixed a typo in
       * the resolution notes would hand the supervisor a queue of duplicates.
       */
      const request = couponChanged ? splitCouponForApproval(draft).request : null;
      /**
       * The coupon columns are ABSENT from the patch, not set to null: they are
       * outside the Agent policy's write scope now (TICKET_FIELDS_AGENT_WRITABLE
       * in roles.ts), and Directus rejects an entire PATCH that so much as names
       * a field the policy does not allow.
       *
       * `compensation` is withheld only while a NEW coupon is waiting, so the
       * ticket never reads "Compensated" for money nobody has approved — and
       * never loses that word over an edit that did not touch the coupon.
       */
      const {
        coupon_code: _c,
        coupon_value: _v,
        coupon_percent: _p,
        ...fields
      } = complaintPatch(draft);
      await update.mutateAsync({
        id: ticket.id,
        patch: {
          ...fields,
          // Read from the draft, not from `fields`: complaintPatch is typed as
          // `string | number | null` across every column, and compensation is
          // text. Withheld only while a NEW coupon is pending.
          compensation: request ? null : draft.compensation.trim() || null,
          store: storeId || null,
        },
      });

      // Raised only after the ticket write lands: a request pointing at an edit
      // that failed is a promise nobody is holding.
      let couponAsked = false;
      if (request) {
        try {
          await requestCoupon.mutateAsync({
            ...request,
            ticket: ticket.id,
            contact: ticket.contact?.id ?? null,
            requested_by: user?.id ?? null,
            reason: draft.response_desc.trim() || null,
          });
          couponAsked = true;
        } catch {
          toast.error(
            t('coupons.requestFailed', {
              defaultValue: 'The coupon was NOT sent for approval — raise it from the ticket.',
            }),
          );
        }
      }

      setEditing(false);
      toast.success(
        couponAsked
          ? t('complaint.savedCouponPending', {
              defaultValue: 'Saved. The coupon is waiting for a supervisor.',
            })
          : t('complaint.saved', { defaultValue: 'Complaint details saved' }),
      );
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

  return (
    <SectionCard
      title={t('complaint.section', { defaultValue: 'Complaint details' })}
      aside={
        !editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(stored);
              setStoreId(ticket.store ?? '');
              setEditing(true);
            }}
            className="text-xs font-medium text-primary transition-colors duration-fast ease-out hover:underline"
          >
            {rows.length
              ? t('actions.edit', { ns: 'common', defaultValue: 'Edit' })
              : t('complaint.add', { defaultValue: 'Add complaint details' })}
          </button>
        )
      }
    >
      {editing ? (
        <div className="space-y-4">
          <StorePicker value={storeId} onChange={setStoreId} />
          <ComplaintClassification
            values={draft}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          />
          <ComplaintResolution
            values={draft}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          />
          {/* Said while the agent is still typing the coupon, not after they
              have told the customer about it — the same warning the create
              dialog carries, because this path raises the same request. */}
          {couponChanged && (
            <p className="flex items-start gap-2 rounded-xl bg-primary/[0.08] px-3 py-2 text-xs leading-relaxed text-foreground">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
              <span>
                {t('coupons.needsApproval', {
                  defaultValue:
                    'A supervisor has to approve this coupon. It is not on the ticket until they do — do not promise it to the customer yet.',
                })}
              </span>
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <SavedTick
              saved={update.isSuccess}
              label={t('actions.saved', { ns: 'common', defaultValue: 'Saved' })}
              className="me-auto"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(stored);
                setStoreId(ticket.store ?? '');
                setEditing(false);
              }}
            >
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button
              type="button"
              size="sm"
              loading={update.isPending}
              disabled={complaintHasErrors(draft)}
              onClick={() => void save()}
            >
              {t('actions.save', { ns: 'common', defaultValue: 'Save' })}
            </Button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('complaint.none', {
            defaultValue: 'Not classified as a complaint yet.',
          })}
        </p>
      ) : (
        <div className="space-y-3">
          {/* Label above value, in a quiet grid. The old shape pushed each
              label and its value to opposite ends of a ruled row, so the eye
              had to cross a gap to pair them and every row drew another line —
              which is what made this panel read as a stack of boxes. */}
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {label}
                </dt>
                <dd
                  dir="auto"
                  className="mt-1 min-w-0 break-words text-sm font-semibold text-foreground"
                >
                  {optionLabel(value)}
                </dd>
              </div>
            ))}
          </dl>
          {stored.response_desc && (
            <p
              dir="auto"
              className="max-w-prose whitespace-pre-wrap rounded-xl bg-secondary/50 px-4 py-3 text-sm leading-relaxed text-foreground/85"
            >
              {stored.response_desc}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * How long the ticket actually took, start to finish.
 *
 * Deliberately measured from `date_created` rather than from the SLA clock: the
 * SLA answers "did we beat the promise", this answers "how long did the
 * customer wait", and on a ticket reopened or re-promised those are different
 * numbers. Blank while the ticket is open — a running total would be read as a
 * result, and there is no result yet.
 */
function ResolutionTimeCard({
  created,
  resolved,
}: {
  created: string | null;
  resolved: string | null;
}) {
  const { t } = useTranslation();
  const secs =
    created && resolved
      ? Math.round((new Date(resolved).getTime() - new Date(created).getTime()) / 1000)
      : null;
  const text = secs !== null && secs >= 0 ? formatDuration(secs) : null;
  return (
    <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t('tickets.resolutionTime', { defaultValue: 'Time to resolve' })}
      </div>
      <div className="mt-1.5 text-lg font-extrabold tabular-nums tracking-[-0.03em] text-foreground">
        {text ?? <span className="text-muted-foreground/60">—</span>}
      </div>
      {!text && (
        <div className="mt-2 text-2xs text-muted-foreground">
          {t('tickets.resolutionTimeOpen', { defaultValue: 'Still open' })}
        </div>
      )}
    </div>
  );
}

/**
 * Who changed this ticket last, and when.
 *
 * Directus stamps `user_updated` on every write, so this is the whole edit
 * history's last line without keeping a second one of our own. Names the agent
 * rather than showing a bare timestamp: "changed at 14:02" tells a supervisor
 * nothing they can follow up on.
 */
function LastTouchedCard({
  by,
  at,
}: {
  by: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
  at: string | null;
}) {
  const { t } = useTranslation();
  const name =
    [by?.first_name, by?.last_name].filter(Boolean).join(' ').trim() || by?.email || null;
  return (
    <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t('tickets.lastUpdated', { defaultValue: 'Last updated' })}
      </div>
      <div className="mt-1.5 text-sm font-semibold text-foreground">
        {name ?? (
          <span className="text-muted-foreground/60">
            {t('tickets.lastUpdatedNobody', { defaultValue: 'Not changed since it was raised' })}
          </span>
        )}
      </div>
      {at && (
        <div className="mt-1 text-2xs tabular-nums text-muted-foreground">
          {new Date(at).toLocaleString()} · {formatRelative(at)}
        </div>
      )}
    </div>
  );
}

function SlaCard({
  label,
  iso,
  metAt,
  created,
  dueClass,
  metLabel,
}: {
  label: string;
  iso: string | null;
  metAt: string | null;
  /** When the clock started — lets the meter say how much promise is spent. */
  created: string | null;
  dueClass: (iso: string | null) => string;
  metLabel?: string;
}) {
  // How much of the window is gone, 0–100 — the board's meter idiom instead of
  // a second sentence about the clock. Met freezes the fill where the work
  // stopped (green); overdue pins it full (red); a ticket with no due date or
  // no start renders no meter rather than a bar measuring nothing.
  const start = created ? new Date(created).getTime() : NaN;
  const due = iso ? new Date(iso).getTime() : NaN;
  const at = metAt ? new Date(metAt).getTime() : Date.now();
  const spent =
    Number.isFinite(start) && Number.isFinite(due) && due > start
      ? Math.min(100, Math.max(0, ((at - start) / (due - start)) * 100))
      : null;
  const meterTone = metAt ? 'success' : at >= due ? 'destructive' : 'primary';
  return (
    <div className="rounded-2xl bg-card p-4 ring-1 ring-foreground/[0.06] shadow-soft">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-1.5 text-base font-extrabold tabular-nums tracking-[-0.03em]',
          dueClass(iso),
        )}
      >
        {iso ? new Date(iso).toLocaleString() : '—'}
      </div>
      {spent !== null && <MeterBar value={spent} tone={meterTone} className="mt-2.5" />}
      {metAt && (
        <div className="mt-2 inline-flex items-center gap-1.5 text-2xs font-medium text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          {metLabel} {new Date(metAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
