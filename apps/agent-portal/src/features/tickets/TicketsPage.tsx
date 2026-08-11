import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  Avatar,
  Button,
  CloseIcon,
  cn,
  formatRelative,
  Pill,
  SelectMenu,
  Skeleton,
  Spinner,
  TicketEmptyArt,
  toast,
  Toolbar,
  ToolbarSpacer,
  useIsDesktop,
} from '@yiji/ui';
import type { Priority, TicketStatus } from '@yiji/shared-types';
import {
  useTickets,
  useTicket,
  useTicketEvents,
  useUpdateTicket,
  useAddTicketNote,
  useAddTicketAttachment,
  useRemoveTicketAttachment,
  useConversationAttachments,
  useAttachExistingFileToTicket,
  type ChatAttachment,
  type TicketRow,
} from './api.js';
import { useAgents, useTeamOptions } from '../inbox/api.js';
import { NewTicketDialog } from './NewTicketDialog.js';
import { TicketAttachments } from './TicketAttachments.js';
import {
  ComplaintClassification,
  ComplaintResolution,
  complaintHasErrors,
  complaintPatch,
  optionLabel,
  type ComplaintValues,
} from './ComplaintFields.js';
import {
  LegacyOrderSnapshotCard,
  OrderSnapshotCard,
  parseLegacyOrderBlock,
} from './OrderSnapshotCard.js';
import { useContact } from '../contacts/api.js';
import { CustomFieldsSection } from '../custom-fields/CustomFieldsSection.js';
import { resolveMentions } from '../conversation/mentions.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { formatBytes, isImage, isUnknownType } from '../../lib/files.js';
import { FileGlyph } from '../../components/FileGlyph.js';
import { useAssetBlobUrl } from '../../lib/useAssetBlobUrl.js';

const STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

type TicketFilter = 'all' | TicketStatus | 'overdue';
const FILTERS: TicketFilter[] = ['all', 'new', 'open', 'pending', 'resolved', 'overdue'];

export function TicketsPage() {
  const { t } = useTranslation();
  const tickets = useTickets();
  const isDesktop = useIsDesktop();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<TicketFilter>('all');
  const [creating, setCreating] = useState(false);

  // Deep-link support: open a specific ticket from /tickets?id=<id> (command
  // palette, AI search) or /tickets/<id> (notification "View" links).
  const { ticketId: pathTicketId } = useParams();
  const [searchParams] = useSearchParams();
  const deepLinkId = pathTicketId ?? searchParams.get('id');
  useEffect(() => {
    if (deepLinkId) setSelected(deepLinkId);
  }, [deepLinkId]);

  const isOverdue = (tk: {
    first_responded_at: string | null;
    first_response_due_at: string | null;
  }) =>
    !tk.first_responded_at &&
    tk.first_response_due_at !== null &&
    new Date(tk.first_response_due_at).getTime() < Date.now();

  const list = tickets.data ?? [];
  const stats = useMemo(() => {
    const open = list.filter((t) => t.status === 'open' || t.status === 'new').length;
    const pending = list.filter((t) => t.status === 'pending').length;
    const overdue = list.filter(isOverdue).length;
    const today = list.filter((t) => {
      if (!t.date_created) return false;
      const d = new Date(t.date_created);
      const now = new Date();
      return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );
    }).length;
    return { open, pending, overdue, today };
  }, [list]);

  const filtered = useMemo(() => {
    if (filter === 'all') return list;
    if (filter === 'overdue') return list.filter(isOverdue);
    return list.filter((t) => t.status === filter);
  }, [list, filter]);

  const filterCount = (f: TicketFilter) => {
    if (f === 'all') return list.length;
    if (f === 'overdue') return stats.overdue;
    return list.filter((t) => t.status === f).length;
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
                <span className={cn('tabular-nums text-2xs', !active && tone)}>{count}</span>
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
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          {t('tickets.newTicket', { defaultValue: '+ New ticket' })}
        </Button>
      </Toolbar>

      {creating && (
        <NewTicketDialog onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)} />
      )}

      {/* Below: list + detail — no card wrapping. Single-column on mobile:
          the list and the detail view swap places. */}
      <div className="flex flex-1 min-h-0 gap-3 p-3">
        {(isDesktop || selected === null) && (
          <aside
            className={cn(
              'flex shrink-0 flex-col overflow-hidden rounded-2xl bg-card shadow-soft',
              isDesktop ? 'w-[360px]' : 'w-full',
            )}
          >
            <div className="flex-1 overflow-auto pt-2">
              {tickets.isLoading ? (
                <ul className="px-2 space-y-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <li key={i} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5">
                      <Skeleton className="h-7 w-7 rounded-full" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-3 w-3/4" />
                        <div className="flex items-center gap-1.5">
                          <Skeleton className="h-3.5 w-12 rounded-full" />
                          <Skeleton className="h-3.5 w-16 rounded-full" />
                        </div>
                        <Skeleton className="h-2.5 w-1/2" />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : filtered.length > 0 ? (
                <ul className="space-y-2 px-3 py-2">
                  {filtered.map((tk) => {
                    const active = selected === tk.id;
                    const overdue = isOverdue(tk);
                    return (
                      <li key={tk.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(tk.id)}
                          className={cn(
                            'group flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-start',
                            'transition-colors duration-fast ease-out',
                            active ? 'bg-primary-subtle/70' : 'hover:bg-secondary/60',
                          )}
                        >
                          {/* Messenger row: avatar with a status dot, subject +
                              contact secondary line, time and exception pills. */}
                          <span className="relative shrink-0">
                            <Avatar
                              name={tk.contact?.name}
                              email={tk.contact?.email}
                              phone={tk.contact?.phone}
                              size="md"
                            />
                            <span
                              aria-hidden
                              title={t(`status.${tk.status}`, { ns: 'common' })}
                              className={cn(
                                'absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-background',
                                {
                                  new: 'bg-primary',
                                  open: 'bg-success',
                                  pending: 'bg-warning',
                                  resolved: 'bg-primary',
                                  closed: 'bg-muted-foreground/40',
                                }[tk.status],
                              )}
                            />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-sm font-semibold text-foreground">
                                {tk.subject}
                              </span>
                              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                                {formatRelative(tk.date_created)}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                {/* The ops team scan this list by category the
                                    way they scan their own sheet, so the
                                    complaint type leads when there is one. */}
                                {tk.complaint_type && (
                                  <span className="font-medium text-foreground/70">
                                    {optionLabel(tk.complaint_type)}
                                    <span aria-hidden> · </span>
                                  </span>
                                )}
                                {tk.contact?.name ??
                                  tk.contact?.email ??
                                  tk.contact?.phone ??
                                  t(`status.${tk.status}`, { ns: 'common' })}
                              </span>
                              {(tk.priority === 'urgent' || tk.priority === 'high') && (
                                <Pill tone={tk.priority === 'urgent' ? 'pink' : 'orange'} size="sm">
                                  {t(`priority.${tk.priority}`, { ns: 'common' })}
                                </Pill>
                              )}
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
          </aside>
        )}

        {(isDesktop || selected !== null) && (
          <section className="flex-1 min-w-0 overflow-auto rounded-2xl bg-card shadow-soft">
            {selected ? (
              <TicketDetail ticketId={selected} onBack={() => setSelected(null)} />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="flex max-w-md flex-col items-center gap-5">
                  <TicketEmptyArt size={200} />
                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold text-display tracking-tight">
                      {t('tickets.selectPrompt', { defaultValue: 'Open a ticket' })}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {t('tickets.selectHint', {
                        defaultValue:
                          'Pick a ticket on the left to see its workflow, SLA timeline, and history.',
                      })}
                    </p>
                  </div>
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
    <li className="flex items-center gap-2 rounded-lg bg-card px-2 py-1.5 ring-1 ring-foreground/[0.04]">
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
 * Mirrors NewTicketDialog's overlay/scale-in styling.
 */
function ChatMediaDialog({
  items,
  loading,
  attachedFileIds,
  pending,
  onAdd,
  onClose,
}: {
  items: ChatAttachment[];
  loading: boolean;
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
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-3xl bg-card p-6 shadow-2xl shadow-foreground/15 ring-1 ring-foreground/[0.06] animate-scale-in">
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
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('tickets.noChatMedia', { defaultValue: 'No files shared in this conversation.' })}
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

  const patch = (p: Parameters<typeof update.mutateAsync>[0]['patch']) =>
    void update
      .mutateAsync({ id: tk.id, patch: p })
      .catch(() => toast.error(t('errors.updateFailed', { ns: 'common' })));

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

  const dueClass = (iso: string | null) => {
    if (!iso) return 'text-muted-foreground';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return 'text-destructive font-medium';
    if (ms < 30 * 60_000) return 'text-warning font-medium';
    return 'text-foreground';
  };

  const statusTone: Record<TicketStatus, 'success' | 'warning' | 'muted' | 'primary' | 'neutral'> =
    {
      new: 'primary',
      open: 'success',
      pending: 'warning',
      resolved: 'primary',
      closed: 'muted',
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
                <Pill tone={tk.priority === 'urgent' ? 'pink' : 'orange'}>
                  {t(`priority.${tk.priority}`, { ns: 'common' })}
                </Pill>
              )}
            </div>
            <h2 className="text-2xl font-bold text-display tracking-[-0.02em] text-balance">
              {tk.subject}
            </h2>
            <div className="text-xs text-muted-foreground">
              {tk.contact?.name ??
                tk.contact?.phone ??
                tk.contact?.email ??
                t('inbox.unknownContact')}
              {tk.date_created && (
                <>
                  {' '}
                  ·{' '}
                  <span className="tabular-nums">
                    opened {new Date(tk.date_created).toLocaleDateString()}
                  </span>
                </>
              )}
              {tk.conversation && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => navigate(`/?conv=${tk.conversation}`)}
                    className="font-medium text-primary transition-colors duration-fast ease-out hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                  >
                    {t('tickets.viewConversation', { defaultValue: 'View conversation →' })}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* The agent's own words only — the order block is stripped out of
            legacy descriptions and rendered as a card below instead. */}
        {(legacyOrder ? legacyOrder.description : tk.description) && (
          <p className="max-w-prose whitespace-pre-wrap rounded-xl bg-secondary/50 px-4 py-3 text-sm leading-relaxed text-foreground/85">
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
            {refetchOrderId ? (
              <LegacyOrderSnapshotCard
                vendorId={orderVendorId as string}
                orderId={refetchOrderId}
              />
            ) : (
              <OrderSnapshotCard order={tk.order_snapshot!} />
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
          {/* Properties — stacked selects + the mark-responded CTA. */}
          <section className="space-y-3 rounded-2xl bg-card p-4 shadow-soft">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('tickets.properties', { defaultValue: 'Properties' })}
            </h3>
            <div className="space-y-2.5">
              <label className="block space-y-1">
                <span className="text-2xs text-muted-foreground">{t('conversation.status')}</span>
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
                <span className="text-2xs text-muted-foreground">{t('conversation.priority')}</span>
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
                <span className="text-2xs text-muted-foreground">{t('conversation.agent')}</span>
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
                <span className="text-2xs text-muted-foreground">{t('conversation.team')}</span>
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
            {!tk.first_responded_at ? (
              // #7 — set apart from the status control above with its own label so
              // it's clear this only stops the SLA timer; it does not resolve or
              // close the ticket.
              <div className="space-y-1.5 rounded-xl bg-secondary/40 p-3">
                <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('tickets.firstResponse', { defaultValue: 'First response' })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  fullWidth
                  onClick={() => patch({ first_responded_at: new Date().toISOString() })}
                >
                  {t('tickets.markResponded', { defaultValue: 'Mark first response' })}
                </Button>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t('tickets.markRespondedHint', {
                    defaultValue:
                      'Logs your first reply and stops the first-response SLA timer — separate from the ticket status.',
                  })}
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-2xs font-medium text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
                {t('tickets.firstResponseLogged', {
                  defaultValue: 'First response logged · {{when}}',
                  when: formatRelative(tk.first_responded_at),
                })}
              </div>
            )}
          </section>

          {/* SLA deadlines — stacked in the rail. */}
          <section className="space-y-2.5">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('tickets.slaSection', { defaultValue: 'SLA' })}
            </h3>
            <div className="space-y-2">
              <SlaCard
                label={t('tickets.firstResponseDue')}
                iso={tk.first_response_due_at}
                metAt={tk.first_responded_at}
                dueClass={dueClass}
                metLabel={t('tickets.respondedAt')}
              />
              <SlaCard
                label={t('tickets.resolutionDue')}
                iso={tk.resolution_due_at}
                metAt={null}
                dueClass={dueClass}
              />
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
              agent sees what was shared without clicking anything. */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold tracking-tight text-foreground">
                {t('tickets.attachments', { defaultValue: 'Attachments' })}
                {tk.attachments && tk.attachments.length > 0 && (
                  <span className="ms-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary-subtle px-1.5 text-xs font-semibold tabular-nums text-primary">
                    {tk.attachments.length}
                  </span>
                )}
              </h3>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => void onPickFiles(e.target.files)}
              />
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
            </div>

            {/* Picker modal: files the customer (or agent) already shared in the
                chat — attach any that weren't carried over at creation. */}
            {showChatMedia && tk.conversation && (
              <ChatMediaDialog
                items={chatItems}
                loading={chatMedia.isLoading}
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
              <p className="text-xs text-muted-foreground">
                {t('tickets.noAttachments', { defaultValue: 'No attachments yet.' })}
              </p>
            )}
          </section>

          {/* Internal note composer — appends a 'commented' event to the history. */}
          <section className="space-y-2">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('tickets.addNote', { defaultValue: 'Add internal note' })}
            </h3>
            <div className="rounded-2xl bg-card/60 p-2 ring-1 ring-foreground/[0.04] focus-within:ring-primary/30">
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
          </section>

          {/* History timeline — actual timeline with connector line */}
          <section className="space-y-3">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t('tickets.history')}
            </h3>
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
                      <span
                        className={cn(
                          'relative z-10 mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full ring-4 ring-background',
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
              <p className="py-6 text-center text-sm text-muted-foreground/80">
                {t('tickets.noEvents')}
              </p>
            )}
          </section>
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
  const [editing, setEditing] = useState(false);

  // Directus hands back numbers for the coupon columns and nulls for anything
  // unset; the form works in strings, so normalise on the way in.
  const stored: ComplaintValues = useMemo(
    () => ({
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
    if (!editing) setDraft(stored);
  }, [stored, editing]);

  const rows: Array<[string, string]> = [
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

  const save = async () => {
    if (complaintHasErrors(draft)) return;
    try {
      await update.mutateAsync({ id: ticket.id, patch: complaintPatch(draft) });
      setEditing(false);
      toast.success(t('complaint.saved', { defaultValue: 'Complaint details saved' }));
    } catch {
      toast.error(t('errors.updateFailed', { ns: 'common' }));
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {t('complaint.section', { defaultValue: 'Complaint details' })}
        </h3>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(stored);
              setEditing(true);
            }}
            className="text-xs font-medium text-primary transition-colors duration-fast ease-out hover:underline"
          >
            {rows.length
              ? t('actions.edit', { ns: 'common', defaultValue: 'Edit' })
              : t('complaint.add', { defaultValue: 'Add complaint details' })}
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-4 rounded-2xl bg-card p-4 shadow-soft">
          <ComplaintClassification
            values={draft}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          />
          <ComplaintResolution
            values={draft}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(stored);
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
        <>
          <dl className="grid gap-x-6 gap-y-2 rounded-2xl bg-card p-4 shadow-soft sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {label}
                </dt>
                <dd className="min-w-0 text-end text-xs text-foreground">{optionLabel(value)}</dd>
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
        </>
      )}
    </section>
  );
}

function SlaCard({
  label,
  iso,
  metAt,
  dueClass,
  metLabel,
}: {
  label: string;
  iso: string | null;
  metAt: string | null;
  dueClass: (iso: string | null) => string;
  metLabel?: string;
}) {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-soft">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-1.5 text-base font-semibold tabular-nums', dueClass(iso))}>
        {iso ? new Date(iso).toLocaleString() : '—'}
      </div>
      {metAt && (
        <div className="mt-2 inline-flex items-center gap-1.5 text-2xs font-medium text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
          {metLabel} {new Date(metAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
