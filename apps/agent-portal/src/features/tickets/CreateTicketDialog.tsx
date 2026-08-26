import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, cn, FormField, Pill, SelectMenu, Textarea, toast } from '@yiji/ui';
import {
  compensationFlag,
  isCouponRequested,
  isNotifyingType,
  manualStoreMatch,
  splitCouponForApproval,
  toStoreSnapshot,
  type CouponRequestDraft,
  type Priority,
  type StoreMatch,
  type YijiOrder,
} from '@yiji/shared-types';
import {
  useConversationAttachmentIds,
  useCreateTicketFromConversation,
  useStoreNotifyTypes,
} from './api.js';
import { orderToSnapshot, type TicketOrderSnapshot } from './OrderSnapshotCard.js';
import {
  ComplaintClassification,
  ComplaintResolution,
  ComplaintSection,
  StorePicker,
  complaintHasErrors,
  complaintPatch,
  complaintFromConversation,
  nowLocalInput,
  optionLabel,
  serviceTypeFromOrder,
  type ComplaintValues,
  complaintSubject,
} from './ComplaintFields.js';
import { useOrderStore, useStores, toStoreRecord } from './useStoreMatch.js';
import { useRequestCouponApproval } from '../coupons/api.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { useContact } from '../contacts/api.js';
import { commerce } from '../../lib/commerce-client.js';
import { clearPinnedOrder, getPinnedOrder } from '../commerce/pinned-order.js';
import { useAuth } from '../../lib/auth/AuthContext.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

/**
 * No `subject`. A ticket's name is its complaint type, by request — one list of
 * agreed categories rather than 1,673 hand-typed titles that no report can group
 * by. `complaint_type` is therefore the one complaint field that is REQUIRED
 * here: it is the only thing standing in for a name, and a nameless ticket is
 * unreadable in every list that shows one.
 */
const schema = z.object({
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
  /** Names where Cancel returns to, e.g. "Back to the chat". Renders the arrow. */
  backLabel?: string;
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
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-md ring-1 transition-colors duration-fast ease-out',
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
  backLabel,
  onCreated,
}: Props) {
  const { t, i18n } = useTranslation();
  const createFromChat = useCreateTicketFromConversation();
  const { user } = useAuth();
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { isSubmitting },
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

  /* Ticking the box IS the compensation decision; the button is unreachable
     until it is made. There is no ticket yet, so the coupon is COLLECTED here
     and raised once the ticket exists — a failed coupon can then never leave a
     half-created ticket behind. */
  const [assignCoupon, setAssignCoupon] = useState(false);
  const [couponOpen, setCouponOpen] = useState(false);
  const [collectedCoupon, setCollectedCoupon] = useState<CouponRequestDraft | null>(null);
  const [includeOrder, setIncludeOrder] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);
  // Seeded lazily with "now": a module-level default would freeze at import
  // and stamp every complaint with the time the tab was opened. The agent can
  // still change it — a complaint phoned in yesterday belongs to yesterday.
  const [complaint, setComplaint] = useState<ComplaintValues>(() => ({
    ...complaintFromConversation,
    complaint_date: nowLocalInput(),
  }));

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

  // The ticket's name. Always the complaint type — never a free-text title —
  // so the ticket list, the reports and the ops spreadsheet all say the same
  // thing about the same ticket.
  /* The complaint type names the ticket — except for "Other", where the agent
     types the name. Without this every Other ticket is called "Other". */
  const subject = complaintSubject(complaint);

  // Whether this complaint reaches the branch, known BEFORE saving. The agent
  // is writing the description and the resolution notes that get forwarded, so
  // they have to know that is what they are doing while they write them.
  const notifyTypes = useStoreNotifyTypes();
  const notifiesStore = isNotifyingType(subject, notifyTypes.data ?? []);

  // A coupon does not go onto the ticket here — it goes to a supervisor. Known
  // while the agent is still typing, so the form can say so before they promise
  // the customer anything.
  const requestCoupon = useRequestCouponApproval();
  const needsApproval = isCouponRequested(complaint);

  const onSubmit = handleSubmit(async (values) => {
    if (!contactId || !vendorId) return;
    if (complaintHasErrors(complaint) || !subject) return;
    try {
      // The description stays the agent's OWN words. The order rides along as
      // structured JSON so the ticket can render it as a real order card
      // instead of a wall of pasted text.
      const description = values.description?.trim() || undefined;

      // The coupon is withheld from the ticket and sent for approval instead.
      // Writing it now and asking after would make the supervisor's decision a
      // formality applied to money the customer has already been promised.
      const coupon = splitCouponForApproval(complaint);

      const created = await createFromChat.mutateAsync({
        ticket: {
          subject,
          description,
          priority: values.priority,
          contact: contactId,
          vendor: vendorId,
          conversation: conversationId ?? null,
          assigned_agent: user?.id ?? null,
          order_snapshot: includeOrder && latestOrder ? orderSnapshot(latestOrder) : null,
          // Lifted out of the snapshot so it is searchable: Directus cannot
          // filter inside a json column, so an order id that lives only in
          // order_snapshot cannot be looked up from the inbox search box.
          order_id: includeOrder && latestOrder ? String(latestOrder.orderId) : null,
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
          // Overrides the coupon fields complaintPatch just wrote — they are
          // the supervisor's to release, not this form's.
          ...coupon.ticket,
        },
        attachmentFileIds: includeFiles ? sessionFileIds : [],
        storeNotifyTypes: notifyTypes.data ?? [],
      });

      // Raised AFTER the ticket, because the request has to point at one. If it
      // fails the ticket still stands and the agent is told the coupon did not
      // go anywhere — the alternative is a promise nobody is holding.
      let couponAsked = false;
      const fullCoupon = collectedCoupon
        ? {
            coupon_code: collectedCoupon.code,
            // The category decides WHICH money field carries the number, and it
            // carries the value AS ENTERED — this used to send `max_discount`
            // into both columns, so a 20% coupon was recorded as its cap and a
            // percentage request read downstream as an amount.
            coupon_value:
              collectedCoupon.discount_category === 'Percentage'
                ? null
                : (collectedCoupon.coupon_value ?? null),
            coupon_percent:
              collectedCoupon.discount_category === 'Percentage'
                ? (collectedCoupon.coupon_percent ?? null)
                : null,
            compensation: compensationFlag(true),
            title: collectedCoupon.title,
            issuing_side: collectedCoupon.issuing_side,
            delivery_type: collectedCoupon.delivery_type,
            coupon_type: collectedCoupon.coupon_type,
            discount_category: collectedCoupon.discount_category,
            valid_from: collectedCoupon.valid_from,
            valid_to: collectedCoupon.valid_to,
            max_discount: collectedCoupon.max_discount,
            usage_limit: collectedCoupon.usage_limit,
            brand_id: collectedCoupon.brand_id ?? null,
            restaurant_id: collectedCoupon.restaurant_id ?? null,
            item_name: collectedCoupon.item_name ?? null,
          }
        : null;
      const request = fullCoupon ?? coupon.request;
      if (request && created?.id) {
        try {
          await requestCoupon.mutateAsync({
            ...request,
            ticket: created.id,
            contact: contactId,
            requested_by: user?.id ?? null,
            reason:
              collectedCoupon?.compensation_reason?.trim() ||
              complaint.response_desc.trim() ||
              null,
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
      // The ticket now holds a snapshot of the order, so the sidebar pin has done
      // its job. Leaving it would show the same order twice — live in the sidebar
      // and frozen on the ticket — with no way to tell which is authoritative.
      if (includeOrder && latestOrder) clearPinnedOrder(conversationId);
      // Say what reached the branch, and say it when it did NOT. An agent who
      // believes the store was told and writes nothing further is the failure
      // mode a silent queue produces.
      const branchLine =
        created?.storeNotify === 'queued'
          ? t('tickets.branchNotified', { defaultValue: 'The branch will be told.' })
          : created?.storeNotify === 'failed'
            ? t('tickets.branchNotifyFailed', {
                defaultValue: 'The branch could NOT be told — tell a supervisor.',
              })
            : created?.storeNotify === 'no-store'
              ? t('tickets.branchNotifyNoStore', {
                  defaultValue: 'No branch attached, so nobody was told.',
                })
              : '';
      const couponLine = couponAsked
        ? t('coupons.sentForApproval', { defaultValue: 'Coupon sent for approval.' })
        : '';
      toast[created?.storeNotify === 'failed' ? 'warning' : 'success'](
        t('tickets.created', { defaultValue: 'Ticket created' }),
        {
          description: [optionLabel(subject), branchLine, couponLine].filter(Boolean).join(' · '),
        },
      );
      // Hand the id back BEFORE closing: a page-hosted form navigates to the new
      // ticket, and closing first would bounce the agent to the inbox on the way.
      if (created?.id) onCreated?.(created.id);
      else onClose();
    } catch {
      toast.error(t('tickets.createError'));
    }
  });

  const hasChatContext = !!conversationId && (!!latestOrder || sessionFileIds.length > 0);
  const canSubmit = !!contactId && !!vendorId && !complaintHasErrors(complaint) && !!subject;

  // Identify the ticket by who and what it is about, not by restating the
  // page's purpose. Empty on a blank standalone form, where the generic hint
  // is still the most useful thing to say.
  const contextLine = [
    // First, because it is what the ticket will be CALLED. With no subject box
    // on the form, this is the only place the agent sees the name they are
    // about to give it.
    subject ? optionLabel(subject) : null,
    contact.data?.name ?? contact.data?.phone ?? null,
    latestOrder ? `#${latestOrder.orderId}` : null,
    chosenMatch?.store ? chosenMatch.restaurantName : null,
  ].filter((v): v is string => !!v);

  const blockedReason = !contactId
    ? t('tickets.pickContactFirst', { defaultValue: 'Choose a customer to continue' })
    : !subject
      ? // Named, not vague: "check the highlighted fields" sends the agent
        // hunting across a fourteen-field form for the one thing missing.
        t('tickets.pickComplaintType', {
          defaultValue: 'Choose a ticket type — it names the ticket',
        })
      : complaintHasErrors(complaint)
        ? t('tickets.fixFieldsFirst', { defaultValue: 'Check the highlighted fields' })
        : '';

  return (
    <form
      onSubmit={onSubmit}
      // The near-black canvas, not a full-bleed sheet: the two form halves are
      // elevated cards now, and cards need ground to float off.
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      noValidate
    >
      {/* One header, not a back-strip stacked on a title bar. Save stays
          reachable from anywhere without scrolling to find it. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-border px-5 py-3.5 sm:px-7">
        {backLabel && (
          <button
            type="button"
            onClick={onClose}
            aria-label={backLabel}
            title={backLabel}
            className="-ms-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:active:scale-[0.97]"
          >
            {/* Logical mirroring: a hard-coded arrow points forward in Arabic. */}
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 rtl:-scale-x-100"
              aria-hidden
            >
              <path d="M10 3 5 8l5 5" />
            </svg>
          </button>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-[-0.01em] text-display">
            {t('tickets.createTitle')}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {contextLine.length > 0 ? (
              // Who and what this ticket is about, rather than a sentence of
              // instructions the agent stops reading on the second visit.
              contextLine.map((bit, i) => (
                <span key={bit} className="flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden className="text-muted-foreground/40">
                      ·
                    </span>
                  )}
                  <span className="truncate">{bit}</span>
                </span>
              ))
            ) : (
              <span>
                {t('tickets.createHint', {
                  defaultValue: 'Capture the work as a ticket so it can be tracked against an SLA.',
                })}
              </span>
            )}
          </p>
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {!canSubmit && blockedReason && (
            // Says WHY the button is dead. A disabled control with no reason is
            // the single most common way a form wastes an agent's time. The dot
            // ties it to Create rather than to the Cancel button beside it.
            <span className="me-1 hidden items-center gap-1.5 text-xs text-muted-foreground lg:inline-flex">
              <span aria-hidden className="h-1 w-1 rounded-full bg-warning" />
              {blockedReason}
            </span>
          )}
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

      {/* Two sections now, not three: Subject is gone and the rest of what was
          the Ticket card lives at the foot of "What happened", so the agent
          fills one story in one pass instead of crossing the page to answer
          half of it. Still columns rather than one tall stack — thirteen fields
          in a single column is two screens of scrolling. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Columns sized to the fields rather than to the monitor, and centred
            in whatever is left. Two 50% columns on a 1920 screen put 640px of
            inputs against a 300px empty gutter each, which reads as a layout
            that failed rather than one that chose. 42.5rem exactly: the
            sections cap their fields at 40rem and pad 1.25rem a side, so a
            wider column just re-opens a ragged gutter inside the card. */}
        <div className="mx-auto grid min-h-0 w-full max-w-[85rem] flex-1 grid-cols-1 gap-5 overflow-y-auto p-5 sm:p-6 lg:grid-cols-2 lg:overflow-hidden">
          <div className="min-h-0 lg:overflow-y-auto">
            <ComplaintSection
              tone="violet"
              title={t('complaint.whatHappened', { defaultValue: 'What happened' })}
              hint={t('complaint.whatHappenedHint', {
                defaultValue: 'The ticket as the customer reported it',
              })}
            >
              <ComplaintClassification
                values={complaint}
                onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
                // The type names the ticket now, so it is the one complaint
                // field that cannot be left blank. Said under the field as well
                // as on the disabled Save button, because that explanation is
                // hidden below a large screen.
                typeRequired
              />

              {/* What was the Ticket card, merged in below the classification
                  and kept in its original order. */}
              <div className="space-y-4 border-t border-border pt-4">
                {contactField}
                <FormField label={t('tickets.description')} htmlFor="ticket-description">
                  <Textarea
                    id="ticket-description"
                    rows={2}
                    dir="auto"
                    {...register('description')}
                  />
                </FormField>
                <div className="grid gap-3.5 sm:grid-cols-2">
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
                  {/* Always rendered: the branch has to be recordable even when
                      there is no order to infer it from. */}
                  <StorePicker
                    value={storeId}
                    onChange={setStoreId}
                    inferredFrom={inferredStoreId || null}
                  />
                </div>
              </div>
            </ComplaintSection>
          </div>

          {/* No rule between the columns any more — the cards' own edges do
              the separating, and the grid gap is logical so RTL is free. */}
          <div className="min-h-0 lg:overflow-y-auto">
            <ComplaintSection
              tone="success"
              title={t('complaint.resolution', { defaultValue: 'Resolution' })}
              hint={t('complaint.resolutionHint', {
                defaultValue: 'Optional — what you did about it',
              })}
            >
              {/* Said BEFORE saving, next to the notes it is about: for these
                  complaint types the description and the resolution notes are
                  forwarded to the branch, and the agent is writing them now. */}
              {notifiesStore && (
                <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground">
                  <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" />
                  <span>
                    {chosenMatch?.store
                      ? t('tickets.branchWillSee', {
                          defaultValue:
                            'This ticket type is reported to the branch. Only the description and the resolution notes are sent.',
                        })
                      : t('tickets.branchWillSeeNoStore', {
                          defaultValue:
                            'This ticket type is reported to the branch — attach one so it can be.',
                        })}
                  </span>
                </p>
              )}
              <div className="rounded-2xl bg-primary/[0.05] p-3.5 ring-1 ring-inset ring-primary/15">
                <label className="flex items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={assignCoupon}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setAssignCoupon(on);
                      if (!on) setCollectedCoupon(null);
                      // The compensation flag follows the box, so the agent is
                      // never asked the same thing twice.
                      setComplaint((c) => ({ ...c, compensation: compensationFlag(on) }));
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">
                      {t('coupons.assign', { defaultValue: 'Assign a coupon' })}
                    </span>
                    <span className="block text-2xs leading-relaxed text-muted-foreground">
                      {t('coupons.assignHint', {
                        defaultValue:
                          'A supervisor approves it before anything reaches the customer.',
                      })}
                    </span>
                  </span>
                </label>
                <div className="mt-3 flex items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!assignCoupon}
                    onClick={() => setCouponOpen(true)}
                  >
                    {t('coupons.create', { defaultValue: 'Create coupon' })}
                  </Button>
                  {collectedCoupon && (
                    <span className="text-2xs font-medium text-success">
                      {t('coupons.attached', {
                        code: collectedCoupon.code,
                        defaultValue: '{{code}} will be sent for approval',
                      })}
                    </span>
                  )}
                </div>
              </div>
              <CouponRequestDialog
                open={couponOpen}
                onClose={() => setCouponOpen(false)}
                ticketId=""
                contactId={contactId}
                customerPhone={contact.data?.phone ?? null}
                description={watch('description') || null}
                // YIJI'S identifiers, not ours. These two fields are sent
                // straight to Yiji when the coupon is pushed, and Yiji does not
                // know our store UUID or, for the one brand where the names
                // differ, our display name: we say "Casa Pasta" where they say
                // "La Casa Pasta". A coupon addressed with our internal ids
                // would be issued against a brand and branch Yiji cannot
                // resolve. Falls back to what we call it only when the mapping
                // is missing, which is at least a name a human can act on.
                brandId={
                  chosenMatch?.store?.brandYijiName?.trim() || chosenMatch?.brandName || null
                }
                restaurantId={chosenMatch?.store?.yijiRestaurantId || null}
                brandName={chosenMatch?.brandName ?? null}
                branchName={chosenMatch?.restaurantName ?? null}
                // The attached order's lines, for the optional Item field. The
                // price rides along so picking an item can fill the coupon with
                // what that item actually cost.
                orderItems={
                  includeOrder && latestOrder
                    ? latestOrder.items.map((it) => ({ name: it.name, price: it.price ?? null }))
                    : []
                }
                requestedBy={user?.id ?? null}
                onCollect={setCollectedCoupon}
              />
              <ComplaintResolution
                values={complaint}
                onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
                hideCoupon
              />
              {/* Said while the agent is still typing the coupon, not after
                  they have told the customer about it. */}
              {needsApproval && (
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
            </ComplaintSection>
          </div>
        </div>

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

  // Nothing to show, so no column. A 20rem rail holding one sentence of advice
  // is 20rem the form does not get, and the advice it held is already the
  // branch picker's own hint. It returns the moment there is an order or a
  // chosen branch, which is also the moment it has something to confirm.
  if (!order && !matched) return null;

  return (
    <aside className="w-full shrink-0 overflow-y-auto border-t border-border bg-background px-6 py-5 lg:w-[20rem] lg:border-s lg:border-t-0">
      {/* Same head as the form sections, in the fourth hue — the tinted chip
          with the sky dot — so the rail reads as a peer of the columns rather
          than a stray panel. */}
      <header className="mb-4 flex items-center gap-2.5">
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-sky-tint"
          aria-hidden
        >
          <span className="h-1.5 w-1.5 rounded-full bg-sky" />
        </span>
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
          {t('complaint.context', { defaultValue: 'Context' })}
        </h2>
        <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
          {t('complaint.readOnly', { defaultValue: 'Read only' })}
        </span>
      </header>
      {order && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
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
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('complaint.branch', { defaultValue: 'Restaurant / branch' })}
          </p>
          <p className="text-sm font-semibold leading-snug text-foreground">
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
        <div className="mt-4 space-y-2.5 border-t border-border pt-4">
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
