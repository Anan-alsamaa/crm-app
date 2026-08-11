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
import {
  OrderSnapshotCard,
  orderToSnapshot,
  type TicketOrderSnapshot,
} from './OrderSnapshotCard.js';
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
  contactId: string;
  vendorId: string;
  conversationId?: string | null;
  onClose: () => void;
  /**
   * `overlay` floats the form over whatever raised it; `page` drops the modal
   * chrome so a route can own the layout. Same form either way — the fields,
   * the pre-fill and the branch attribution are defined once.
   */
  chrome?: 'overlay' | 'page';
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
  chrome = 'overlay',
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
  const contact = useContact(contactId);
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
  const asPage = chrome === 'page';

  return (
    <div
      // A page is not a dialog. Announcing one as `role="dialog"` with
      // `aria-modal` tells a screen reader the rest of the app is inert when it
      // is simply gone, and there is no backdrop to dismiss.
      {...(asPage
        ? {}
        : {
            role: 'dialog',
            'aria-modal': true as const,
            onClick: (e: React.MouseEvent) => {
              if (e.target === e.currentTarget) onClose();
            },
          })}
      className={cn(
        asPage
          ? 'flex min-h-0 flex-1 justify-center overflow-y-auto p-4 sm:p-6'
          : 'fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-md animate-fade-in',
      )}
    >
      {/* Wide, scrolling sheet rather than the old max-w-md card: this is a
          form with three sections now, and his agents fill it in one pass. */}
      <div
        className={cn(
          'flex w-full max-w-2xl flex-col rounded-3xl bg-card ring-1 ring-foreground/[0.06]',
          asPage
            ? // On its own page the outer container scrolls, so the sheet grows
              // with the form instead of trapping a second scrollbar inside it.
              'h-fit shadow-sm'
            : 'max-h-[90vh] overflow-hidden shadow-2xl shadow-foreground/15 animate-scale-in',
        )}
      >
        <div className="space-y-1.5 px-7 pb-4 pt-7">
          <h3 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
            {t('tickets.createTitle')}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('tickets.createHint', {
              defaultValue: 'Capture the work as a ticket so it can be tracked against an SLA.',
            })}
          </p>
        </div>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 pb-2">
            {/* ── Order & branch ───────────────────────────────────────────
                His first section. Ours is the real order card plus the
                opt-in toggles, so the agent sees exactly what is being
                attached instead of trusting a checkbox label.
                Always rendered — the branch has to be recordable even when
                there is no order to infer it from. */}
            <ComplaintSection
              title={t('complaint.orderAndBranch', { defaultValue: 'Order & branch' })}
            >
              <StorePicker
                value={storeId}
                onChange={setStoreId}
                inferredFrom={inferredStoreId || null}
              />
              {hasChatContext && (
                <>
                  {latestOrder && (
                    <>
                      <IncludeToggle checked={includeOrder} onChange={setIncludeOrder}>
                        <span className="font-medium">
                          {t('tickets.includeOrder', { defaultValue: 'Attach order details' })}
                        </span>
                        {/* This is the customer's LATEST order, which may be
                          unrelated to this chat (the conversation schema carries
                          no order reference), so the agent must be able to see
                          which order it is before attaching it. */}
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                          <span className="font-mono">#{latestOrder.orderId}</span>
                          <Pill tone="neutral" size="sm">
                            {titleize(latestOrder.status)}
                          </Pill>
                          <span className="tabular-nums">
                            {money(latestOrder.total, latestOrder.currency)}
                          </span>
                          <span aria-hidden>·</span>
                          <span className="tabular-nums">
                            {formatOrderDate(latestOrder.placedAt, i18n.language)}
                          </span>
                        </span>
                      </IncludeToggle>
                      {includeOrder && orderSnapshotView && (
                        <OrderSnapshotCard order={orderSnapshotView} className="mt-1" />
                      )}
                    </>
                  )}
                  {sessionFileIds.length > 0 && (
                    <IncludeToggle checked={includeFiles} onChange={setIncludeFiles}>
                      <span className="font-medium">
                        {t('tickets.includeAttachments', {
                          defaultValue: 'Attach files shared in this chat',
                        })}
                      </span>
                      <span className="mt-0.5 block text-muted-foreground">
                        {t('tickets.includeAttachmentsCount', {
                          defaultValue: '{{count}} files from this session',
                          count: sessionFileIds.length,
                        })}
                      </span>
                    </IncludeToggle>
                  )}
                </>
              )}
            </ComplaintSection>

            {/* ── What happened ─────────────────────────────────────────── */}
            <ComplaintSection
              title={t('complaint.whatHappened', { defaultValue: 'What happened' })}
            >
              <FormField
                label={t('tickets.subject')}
                htmlFor="ticket-subject"
                error={errors.subject?.message}
              >
                <Input id="ticket-subject" invalid={!!errors.subject} {...register('subject')} />
              </FormField>
              <FormField label={t('tickets.description')} htmlFor="ticket-description">
                <Textarea
                  id="ticket-description"
                  rows={3}
                  dir="auto"
                  {...register('description')}
                />
              </FormField>
              <ComplaintClassification
                values={complaint}
                onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
              />
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
            </ComplaintSection>

            {/* ── Resolution ────────────────────────────────────────────── */}
            <ComplaintSection title={t('complaint.resolution', { defaultValue: 'Resolution' })}>
              <ComplaintResolution
                values={complaint}
                onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
              />
            </ComplaintSection>
          </div>

          <div className="flex justify-end gap-2 border-t border-foreground/[0.06] px-7 py-4">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
            <Button
              type="submit"
              size="md"
              disabled={complaintHasErrors(complaint)}
              loading={isSubmitting || createFromChat.isPending}
            >
              {t('tickets.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
