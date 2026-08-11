import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, cn, FormField, Input, Pill, SelectMenu, Textarea, toast } from '@yiji/ui';
import {
  manualStoreMatch,
  toStoreSnapshot,
  type Priority,
  type StoreMatch,
  type YijiOrder,
} from '@yiji/shared-types';
import { useConversationAttachmentIds, useCreateTicketFromConversation } from './api.js';
import { orderToSnapshot, type TicketOrderSnapshot } from './OrderSnapshotCard.js';
import {
  ComplaintClassification,
  ComplaintResolution,
  ComplaintSection,
  StorePicker,
  complaintHasErrors,
  complaintPatch,
  complaintFromConversation,
  serviceTypeFromOrder,
  type ComplaintValues,
} from './ComplaintFields.js';
import { useOrderStore, useStores, toStoreRecord } from './useStoreMatch.js';
import { useContact } from '../contacts/api.js';
import { commerce } from '../../lib/commerce-client.js';
import { clearPinnedOrder, getPinnedOrder } from '../commerce/pinned-order.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

const schema = z.object({
  subject: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
});
type FormValues = z.infer<typeof schema>;

interface Props {
  /**
   * Null while the agent has not chosen a customer yet — the standalone route
   * has no conversation to take one from. Submit stays disabled until both are
   * known rather than failing on save with the form filled in.
   */
  contactId: string | null;
  vendorId: string | null;
  /**
   * The customer control, supplied by the route so this form does not need to
   * know whether the contact came from a chat or a search.
   */
  contactField?: React.ReactNode;
  conversationId?: string | null;
  onClose: () => void;
  /** The new ticket's id, for callers that navigate to it. */
  onCreated?: (ticketId: string) => void;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `in_delivery` → `In delivery`. */
function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Short, locale-aware order date (falls back to the raw ISO string). */
function formatOrderDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Capture the chat's order as a STRUCTURED point-in-time snapshot persisted to
 * `tickets.order_snapshot` (JSON). It is a snapshot rather than a live lookup
 * because the order may change or vanish upstream — but storing it as data (not
 * prose appended to `description`) lets the ticket render a real order card and
 * keeps the fields queryable.
 */
function orderSnapshot(order: YijiOrder): TicketOrderSnapshot {
  return { ...orderToSnapshot(order), capturedAt: new Date().toISOString() };
}

/** Small labelled checkbox row used to opt the chat context in/out. */
function IncludeToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] ring-1 transition-colors duration-fast ease-out',
          checked
            ? 'bg-primary text-primary-foreground ring-primary'
            : 'bg-card text-transparent ring-foreground/20',
        )}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="h-3 w-3"
          aria-hidden
        >
          <path d="m3 8 3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 text-xs leading-relaxed text-foreground">{children}</span>
    </label>
  );
}

export function CreateTicketDialog({
  contactId,
  vendorId,
  conversationId,
  onClose,
  contactField,
  onCreated,
}: Props) {
  const { t, i18n } = useTranslation();
  const createFromChat = useCreateTicketFromConversation();
  const { user } = useAuth();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { priority: 'medium' },
  });

  // Chat context (#3): the order shown in this chat + the files shared in it.
  // Both are best-effort — a chat with no linked Yiji customer or no attachments
  // simply hides that row; ticket creation never depends on either resolving.
  const contact = useContact(contactId ?? '');
  const yijiVendorId = contact.data?.vendor?.yiji_vendor_id ?? '';
  const externalCustomerId = contact.data?.external_customer_id ?? '';
  const ordersQuery = useQuery({
    queryKey: ['yiji-latest-order-detail', yijiVendorId, externalCustomerId],
    enabled: !!conversationId && !!yijiVendorId && !!externalCustomerId,
    // The list endpoint is a SUMMARY (id/status/total/date only) — line items,
    // brand/restaurant and delivery type live on the single-order endpoint. Take
    // the newest id from the list, then fetch its full detail, otherwise the
    // snapshot we persist onto the ticket would be missing those fields.
    queryFn: async () => {
      const list = await commerce.getOrders(yijiVendorId, externalCustomerId, { limit: 1 });
      const summary = list?.[0];
      if (!summary) return null;
      const full = await commerce.getOrder(yijiVendorId, summary.orderId).catch(() => null);
      return full ?? summary;
    },
    staleTime: 60_000,
  });
  // The PINNED order wins over the automatic lookup. A pin is a deliberate act
  // — the agent typed that order number in, or clicked that order id in the
  // sidebar to raise a complaint about it — whereas the lookup only ever
  // guesses the customer's newest order. Preferring the guess would silently
  // snapshot the wrong order onto the ticket whenever the complaint is about an
  // older one, and for an unlinked contact the lookup returns nothing at all.
  const latestOrder = getPinnedOrder(conversationId) ?? ordersQuery.data ?? null;
  const sessionFiles = useConversationAttachmentIds(conversationId ?? null);
  const sessionFileIds = sessionFiles.data ?? [];

  const [includeOrder, setIncludeOrder] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [complaint, setComplaint] = useState<ComplaintValues>(complaintFromConversation);

  // The order already knows how it was fulfilled, so pre-fill service type
  // rather than making the agent read it off the card and retype it. Only fills
  // a field the agent has not touched — never overwrites their choice.
  const orderSnapshotView = useMemo(
    () => (latestOrder ? orderToSnapshot(latestOrder) : null),
    [latestOrder],
  );
  const inferredService = serviceTypeFromOrder(orderSnapshotView);
  useEffect(() => {
    if (!inferredService) return;
    setComplaint((c) => (c.service_type ? c : { ...c, service_type: inferredService }));
  }, [inferredService]);

  // Same idea for the branch: resolve the order's restaurant against the store
  // master and pre-select it. `brand_only` is deliberately excluded — it means
  // we matched the BRAND, not a branch, and pre-filling one of that brand's
  // branches would be a guess the agent has no reason to doubt.
  const [storeId, setStoreId] = useState('');
  const orderStore = useOrderStore(orderSnapshotView ?? {});
  const inferredStoreId =
    orderStore.store && orderStore.via !== 'brand_only' && orderStore.via !== 'none'
      ? orderStore.store.id
      : '';
  useEffect(() => {
    if (!inferredStoreId) return;
    setStoreId((cur) => cur || inferredStoreId);
  }, [inferredStoreId]);

  /**
   * The branch the ticket is actually filed against, and the single source for
   * BOTH the `store` link and the frozen `store_snapshot` — deriving them
   * separately is how a ticket ends up linked to one branch while its report
   * row names another.
   *
   * Leaving the pre-selection untouched keeps the automatic match and its
   * evidence (`via: 'yiji_id'`). Changing it makes the agent's choice
   * authoritative and records it as `via: 'manual'`, so a hand-attributed
   * ticket stays distinguishable from one keyed off the order's restaurantId.
   */
  const stores = useStores();
  const chosenMatch = useMemo<StoreMatch | null>(() => {
    if (storeId && storeId !== orderStore.store?.id) {
      const picked = (stores.data ?? []).find((s) => s.id === storeId);
      if (picked) return manualStoreMatch(toStoreRecord(picked));
    }
    // No order and no pick means there is nothing to attribute — record
    // nothing rather than an empty snapshot that reads as a failed match.
    if (!orderSnapshotView && !storeId) return null;
    return orderStore;
  }, [storeId, orderStore, stores.data, orderSnapshotView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = handleSubmit(async (values) => {
    if (!contactId || !vendorId) return;
    if (complaintHasErrors(complaint)) return;
    try {
      // The description stays the agent's OWN words. The order rides along as
      // structured JSON so the ticket can render it as a real order card
      // instead of a wall of pasted text.
      const description = values.description?.trim() || undefined;

      const created = await createFromChat.mutateAsync({
        ticket: {
          subject: values.subject,
          description,
          priority: values.priority,
          contact: contactId,
          vendor: vendorId,
          conversation: conversationId ?? null,
          assigned_agent: user?.id ?? null,
          order_snapshot: includeOrder && latestOrder ? orderSnapshot(latestOrder) : null,
          // Which branch, live — what reports group by and what gets corrected.
          store: chosenMatch?.store?.id ?? null,
          // ...and who it belonged to at the time. Frozen, because resolved
          // live at report time one edit to a store would rewrite every past
          // report — see StoreSnapshot in @yiji/shared-types.
          //
          // Both come from the SAME match, so the link and the frozen copy can
          // never describe different branches.
          store_snapshot: chosenMatch
            ? toStoreSnapshot(chosenMatch, new Date().toISOString())
            : null,
          ...complaintPatch(complaint),
        },
        attachmentFileIds: includeFiles ? sessionFileIds : [],
      });
      // The ticket now holds a snapshot of the order, so the sidebar pin has done
      // its job. Leaving it would show the same order twice — live in the sidebar
      // and frozen on the ticket — with no way to tell which is authoritative.
      if (includeOrder && latestOrder) clearPinnedOrder(conversationId);
      toast.success(t('tickets.created', { defaultValue: 'Ticket created' }), {
        description: values.subject,
      });
      // Hand the id back BEFORE closing: a page-hosted form navigates to the new
      // ticket, and closing first would bounce the agent to the inbox on the way.
      if (created?.id) onCreated?.(created.id);
      else onClose();
    } catch {
      toast.error(t('tickets.createError'));
    }
  });

  const hasChatContext = !!conversationId && (!!latestOrder || sessionFileIds.length > 0);
  const canSubmit = !!contactId && !!vendorId && !complaintHasErrors(complaint);

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
      {/* Actions live in the header, not below the fields. On a multi-column
          form the Save button would otherwise sit under whichever column
          happened to be longest, and the agent would scroll to find it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-foreground/[0.06] bg-card px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-[-0.01em] text-foreground">
            {t('tickets.createTitle')}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {t('tickets.createHint', {
              defaultValue: 'Capture the work as a ticket so it can be tracked against an SLA.',
            })}
          </p>
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button
            type="submit"
            size="md"
            disabled={!canSubmit}
            loading={isSubmitting || createFromChat.isPending}
          >
            {t('tickets.create')}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {/* Columns rather than one tall stack: fourteen fields in a single
            column is two screens of scrolling, and this is filled in one pass.
            The order rail comes last so it reads as reference, not input. */}
        <div className="mx-auto grid w-full max-w-[104rem] items-start gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_19rem]">
          <ComplaintSection title={t('complaint.ticket', { defaultValue: 'Ticket' })}>
            {contactField}
            <FormField
              label={t('tickets.subject')}
              htmlFor="ticket-subject"
              error={errors.subject?.message}
            >
              <Input id="ticket-subject" invalid={!!errors.subject} {...register('subject')} />
            </FormField>
            <FormField label={t('tickets.description')} htmlFor="ticket-description">
              <Textarea id="ticket-description" rows={3} dir="auto" {...register('description')} />
            </FormField>
            <FormField label={t('conversation.priority')} htmlFor="ticket-priority">
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <SelectMenu
                    fullWidth
                    value={field.value}
                    onChange={field.onChange}
                    aria-label={t('conversation.priority')}
                    options={PRIORITIES.map((p) => ({
                      value: p,
                      label: t(`priority.${p}`, { ns: 'common' }),
                    }))}
                  />
                )}
              />
            </FormField>
            {/* Always rendered: the branch has to be recordable even when there
                is no order to infer it from. */}
            <StorePicker
              value={storeId}
              onChange={setStoreId}
              inferredFrom={inferredStoreId || null}
            />
          </ComplaintSection>

          <ComplaintSection title={t('complaint.whatHappened', { defaultValue: 'What happened' })}>
            <ComplaintClassification
              values={complaint}
              onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
            />
          </ComplaintSection>

          <ComplaintSection title={t('complaint.resolution', { defaultValue: 'Resolution' })}>
            <ComplaintResolution
              values={complaint}
              onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
            />
          </ComplaintSection>

          <OrderRail
            order={latestOrder}
            store={chosenMatch}
            includeOrder={includeOrder}
            onIncludeOrder={setIncludeOrder}
            includeFiles={includeFiles}
            onIncludeFiles={setIncludeFiles}
            fileCount={sessionFileIds.length}
            hasChatContext={hasChatContext}
            locale={i18n.language}
          />
        </div>
      </div>
    </form>
  );
}

/** One reference line in the rail: quiet label, readable value. */
function RailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-end font-medium text-foreground">{value}</span>
    </div>
  );
}

/**
 * The order and the branch it came from, as a narrow reference column.
 *
 * Deliberately NOT the full OrderSnapshotCard used on the ticket itself: here
 * the order is context for filling in a form, not the subject of the page, and
 * at this width its line items and totals would push the actual inputs off
 * screen. Everything is read-only apart from the two attach toggles, which
 * decide what the ticket keeps.
 */
function OrderRail({
  order,
  store,
  includeOrder,
  onIncludeOrder,
  includeFiles,
  onIncludeFiles,
  fileCount,
  hasChatContext,
  locale,
}: {
  order: YijiOrder | null;
  store: StoreMatch | null;
  includeOrder: boolean;
  onIncludeOrder: (v: boolean) => void;
  includeFiles: boolean;
  onIncludeFiles: (v: boolean) => void;
  fileCount: number;
  hasChatContext: boolean;
  locale: string;
}) {
  const { t } = useTranslation();
  const matched = store?.store ?? null;

  if (!order && !matched) {
    return (
      <aside className="rounded-2xl bg-secondary/40 p-4 text-xs leading-relaxed text-muted-foreground ring-1 ring-foreground/[0.05]">
        {t('tickets.noOrderContext', {
          defaultValue:
            'No order attached. Pick a branch on the left so the ticket still reports against one.',
        })}
      </aside>
    );
  }

  return (
    <aside className="space-y-3 rounded-2xl bg-secondary/40 p-4 ring-1 ring-foreground/[0.05]">
      {order && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-semibold text-foreground">
              #{order.orderId}
            </span>
            <Pill tone="neutral" size="sm">
              {titleize(order.status)}
            </Pill>
          </div>
          <RailRow
            label={t('commerce.total', { defaultValue: 'Total' })}
            value={<span className="tabular-nums">{money(order.total, order.currency)}</span>}
          />
          <RailRow
            label={t('commerce.placed', { defaultValue: 'Placed' })}
            value={<span className="tabular-nums">{formatOrderDate(order.placedAt, locale)}</span>}
          />
        </div>
      )}

      {matched && (
        <div className="space-y-2 border-t border-foreground/[0.06] pt-3">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('complaint.branch', { defaultValue: 'Restaurant / branch' })}
          </p>
          <p className="text-xs font-semibold leading-snug text-foreground">
            {store?.restaurantName}
          </p>
          <RailRow label={t('stores.brand', { defaultValue: 'Brand' })} value={store?.brandName} />
          {store?.city && (
            <RailRow label={t('stores.city', { defaultValue: 'City' })} value={store.city} />
          )}
          {store?.areaManager && (
            <RailRow
              label={t('tickets.areaManager', { defaultValue: 'Area' })}
              value={store.areaManager}
            />
          )}
          {store?.chainManager && (
            <RailRow
              label={t('tickets.chainManager', { defaultValue: 'Chain' })}
              value={store.chainManager}
            />
          )}
        </div>
      )}

      {hasChatContext && (
        <div className="space-y-2.5 border-t border-foreground/[0.06] pt-3">
          {order && (
            <IncludeToggle checked={includeOrder} onChange={onIncludeOrder}>
              <span className="font-medium">
                {t('tickets.includeOrder', { defaultValue: 'Attach order details' })}
              </span>
            </IncludeToggle>
          )}
          {fileCount > 0 && (
            <IncludeToggle checked={includeFiles} onChange={onIncludeFiles}>
              <span className="font-medium">
                {t('tickets.includeAttachments', {
                  defaultValue: 'Attach files shared in this chat',
                })}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {t('tickets.includeAttachmentsCount', {
                  defaultValue: '{{count}} files from this session',
                  count: fileCount,
                })}
              </span>
            </IncludeToggle>
          )}
        </div>
      )}
    </aside>
  );
}
