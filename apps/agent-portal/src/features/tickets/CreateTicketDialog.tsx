import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, cn, formatDate, FormField, Pill, SelectMenu, Textarea, toast } from '@yiji/ui';
import {
  compensationFlag,
  displayContactName,
  isCouponRequested,
  isNotifyingType,
  manualStoreMatch,
  pickCompensationRule,
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
  useUpdateTicket,
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
import { useRequestCouponApproval, type CreateCouponRequestInput } from '../coupons/api.js';
import { CouponNotSentDialog } from '../coupons/CouponNotSentDialog.js';
import { newCouponRequestId, type CouponRequestError } from '../coupons/coupon-request-send.js';
import { raiseTicketCoupon } from '../coupons/ticket-coupon.js';
import { couponTermsFromDraft } from '../coupons/coupon-request-fields.js';
import { CouponRequestDialog } from '../coupons/CouponRequestDialog.js';
import { useCompensationRules, useRuleLimitReached } from '../coupons/compensation-rules.js';
import {
  isAdjusted,
  nextRuleCoupon,
  policyFields,
  suggestionFor,
  type AppliedRule,
} from '../coupons/rule-prefill.js';
import { useContact } from '../contacts/api.js';
import { commerce } from '../../lib/commerce-client.js';
import { clearPinnedOrder, getPinnedOrder } from '../commerce/pinned-order.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import {
  clearTicketDraft,
  readTicketDraft,
  ticketDraftKey,
  writeTicketDraft,
  type TicketFormDraft,
} from './ticket-draft.js';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

/** What the ticket save hands back: the new id and the branch-notify outcome. */
type CreatedTicket = Awaited<
  ReturnType<ReturnType<typeof useCreateTicketFromConversation>['mutateAsync']>
>;

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
  /**
   * Called when the agent throws the saved draft away ("Clear"), so a caller
   * holding part of the form — the page's contact picker — can reset it too.
   */
  onDiscardDraft?: () => void;
}

/**
 * Whether the agent has actually put anything into the complaint. Fields the
 * form fills in by itself — the date, and a service type read off the order —
 * do not count, or every chat-opened form would be a "draft".
 */
function complaintTouched(c: ComplaintValues, inferredService: string | null): boolean {
  return (Object.keys(complaintFromConversation) as (keyof ComplaintValues)[]).some((k) => {
    if (k === 'complaint_date') return false;
    if (k === 'service_type' && c.service_type === (inferredService ?? '')) return false;
    if (k === 'compensation') return false; // follows the coupon box, counted there
    return (c[k] ?? '') !== (complaintFromConversation[k] ?? '');
  });
}

/**
 * The Add-ticket form, KEPT across navigation and reloads (owner, 2026-10-07).
 *
 * This wrapper owns the draft's identity: one per signed-in agent per chat (or
 * one standalone), see `ticket-draft.ts`. Keying the form on it means a route
 * that switches conversation underneath a mounted form starts that chat's own
 * draft rather than carrying the previous chat's text across. "Clear" remounts
 * the form from nothing rather than resetting a dozen pieces of state by hand —
 * a reset that misses one field is how a discarded coupon reappears.
 */
export function CreateTicketDialog(props: Props) {
  const { user } = useAuth();
  const draftKey = ticketDraftKey(user?.id, props.conversationId);
  const [generation, setGeneration] = useState(0);
  const { onDiscardDraft } = props;
  const discard = useCallback(() => {
    clearTicketDraft(draftKey);
    setGeneration((g) => g + 1);
    onDiscardDraft?.();
  }, [draftKey, onDiscardDraft]);
  return (
    <CreateTicketForm
      key={`${draftKey ?? 'no-draft'}:${generation}`}
      {...props}
      draftKey={draftKey}
      onDiscardDraft={discard}
    />
  );
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

/*
 * The order date as dd/mm/yyyy (falls back to the raw ISO string).
 *
 * Was `dateStyle: 'medium'` in the UI locale, which renders `Aug 21, 2026` in
 * English and a different form in Arabic. The product writes dates one way
 * everywhere, so this now defers to the shared formatter; `locale` is kept in
 * the signature only so callers do not all have to change.
 */
function formatOrderDate(iso: string, _locale: string): string {
  return formatDate(iso) || iso;
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
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50">
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

function CreateTicketForm({
  contactId,
  vendorId,
  conversationId,
  onClose,
  contactField,
  backLabel,
  onCreated,
  draftKey,
  onDiscardDraft,
}: Props & { draftKey: string | null }) {
  const { t, i18n } = useTranslation();
  const createFromChat = useCreateTicketFromConversation();
  const updateTicket = useUpdateTicket();
  const { user, can } = useAuth();
  const canRequestCoupon = can('request_coupons');
  /* Read ONCE, on mount: the draft seeds the form, and from then on the form
     is the truth and the draft its copy. */
  const [initialDraft] = useState(() => readTicketDraft(draftKey));
  const restored: TicketFormDraft | null = initialDraft?.form ?? null;
  const draftRestored = !!(initialDraft?.form || initialDraft?.contact);
  /* Set once the draft has been consumed (saved or cancelled), so a render on
     the way out cannot write the form back into storage. */
  const draftDone = useRef(false);
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      priority: restored?.priority ?? 'medium',
      description: restored?.description ?? '',
    },
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
  /*
   * AN ORDER TYPED IN BY HAND.
   *
   * Every source of an order above needs a CONVERSATION: the automatic lookup
   * is gated on one, and `getPinnedOrder` returns null without one. So a ticket
   * raised from the Add-ticket page — a phoned-in complaint, which is most of
   * them — could never carry an order at all.
   *
   * That is not cosmetic. `CreateCouponUserFromOrder` attaches a coupon TO AN
   * ORDER, so a coupon on such a ticket can never be delivered: it sits
   * approved for ever while the worker logs "no order to attach to". Two
   * coupons were stuck exactly that way, owed to a real customer.
   *
   * The customer is reading the number off their phone either way, so the
   * honest fix is a box to type it into. Deliberately its own state rather than
   * `chooseOrder`, which is keyed by conversation and would have nowhere to
   * live here.
   */
  const [typedOrderId, setTypedOrderId] = useState(restored?.typedOrderId ?? '');
  const [lookupId, setLookupId] = useState(restored?.lookupId ?? '');
  const typedOrderQuery = useQuery({
    queryKey: ['manual-order', yijiVendorId, lookupId],
    enabled: !!yijiVendorId && !!lookupId,
    queryFn: () => commerce.getOrder(yijiVendorId, lookupId),
    retry: false,
    staleTime: 60_000,
  });

  /*
   * A typed order wins over both.
   *
   * It is the most deliberate signal there is — the agent read a number off a
   * phone call and typed it — where the automatic lookup only ever guesses the
   * customer's newest order and the pin may be stale from an earlier ticket.
   */
  const latestOrder =
    (typedOrderQuery.data as YijiOrder | null | undefined) ??
    getPinnedOrder(conversationId) ??
    ordersQuery.data ??
    null;
  const sessionFiles = useConversationAttachmentIds(conversationId ?? null);
  const sessionFileIds = sessionFiles.data ?? [];

  /* Ticking the box IS the compensation decision; the button is unreachable
     until it is made. There is no ticket yet, so the coupon is COLLECTED here
     and raised once the ticket exists — a failed coupon can then never leave a
     half-created ticket behind. */
  const [assignCoupon, setAssignCoupon] = useState(restored?.assignCoupon ?? false);
  const [couponOpen, setCouponOpen] = useState(false);
  const [collectedCoupon, setCollectedCoupon] = useState<CouponRequestDraft | null>(
    restored?.collectedCoupon ?? null,
  );
  /* THE COMPENSATION RULE behind the collected coupon, when it was PRE-FILLED
     (owner, 2026-10-27) - and whether the agent switched that off. */
  const [couponRule, setCouponRule] = useState<AppliedRule | null>(restored?.couponRule ?? null);
  const [couponRuleDeclined, setCouponRuleDeclined] = useState(
    restored?.couponRuleDeclined ?? false,
  );
  const [includeOrder, setIncludeOrder] = useState(restored?.includeOrder ?? true);
  const [includeFiles, setIncludeFiles] = useState(restored?.includeFiles ?? true);
  // Seeded lazily with "now": a module-level default would freeze at import
  // and stamp every complaint with the time the tab was opened. The agent can
  // still change it — a complaint phoned in yesterday belongs to yesterday.
  // A restored draft keeps the date it was given.
  const [complaint, setComplaint] = useState<ComplaintValues>(() => ({
    ...complaintFromConversation,
    complaint_date: nowLocalInput(),
    ...(restored?.complaint ?? {}),
  }));

  /*
   * WALK-IN SERVICE TYPES TAKE THE NUMBER AS TYPED (owner, 2026-09-15).
   *
   * Takeout and Dine-in are walk-in customers. They read out the number on the
   * restaurant's own receipt, which is NOT the Yiji order id the lookup
   * searches — so Find always failed and the agent could not attach the only
   * reference the customer had. For those two the typed value is accepted
   * as-is: no lookup, no snapshot (there is no order to snapshot), just the
   * number recorded on the ticket so it can be searched and quoted back.
   */
  const walkInService =
    complaint.service_type === 'Takeout' || complaint.service_type === 'Dine-in';
  const unverifiedOrderId = walkInService ? typedOrderId.trim() : '';

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
  const [storeId, setStoreId] = useState(restored?.storeId ?? '');
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

  /*
   * PRE-FILL FROM THE COMPENSATION RULES (owner, 2026-10-27).
   *
   * The complaint type (and service type, and the attached order's value) pick
   * the matching rule; its coupon fills the section below. The agent accepts
   * it as is, adjusts it (the request then says "differs from policy") or
   * unticks it. No rule, or the customer at the optional limit: nothing is
   * pre-filled. Delay is not known on this form, so a rule that needs one
   * never pre-fills here. Reads only Directus - never Yiji.
   */
  const rules = useCompensationRules(canRequestCoupon);
  const ruleLimit = useRuleLimitReached(contactId, canRequestCoupon);
  const matchedRule = useMemo(
    () =>
      ruleLimit.data?.reached
        ? null
        : pickCompensationRule(rules.data ?? [], {
            complaintType: complaint.complaint_type,
            serviceType: complaint.service_type || null,
            orderValue: includeOrder && latestOrder ? latestOrder.total : null,
            delayMinutes: null,
          }),
    [
      rules.data,
      ruleLimit.data?.reached,
      complaint.complaint_type,
      complaint.service_type,
      includeOrder,
      latestOrder,
    ],
  );
  useEffect(() => {
    if (!canRequestCoupon || rules.isLoading) return;
    const current = {
      assignCoupon,
      collectedCoupon,
      rule: couponRule,
      declined: couponRuleDeclined,
    };
    const next = nextRuleCoupon(current, matchedRule, (rule) =>
      suggestionFor(rule, {
        today: new Date(),
        phone: contact.data?.phone ?? null,
        brandId: chosenMatch?.store?.brandYijiName?.trim() || chosenMatch?.brandName || null,
        restaurantId: chosenMatch?.store?.yijiRestaurantId || null,
      }),
    );
    if (next === current) return;
    setAssignCoupon(next.assignCoupon);
    setCollectedCoupon(next.collectedCoupon);
    setCouponRule(next.rule);
    setComplaint((c) => ({ ...c, compensation: compensationFlag(next.assignCoupon) }));
    // Only when the MATCH changes: the agent's own edits must not re-trigger it.
  }, [matchedRule?.id, canRequestCoupon, rules.isLoading]);
  const couponAdjusted = isAdjusted({ rule: couponRule, collectedCoupon });

  /* The coupon that did not go out with the ticket just saved, while the
     agent decides: Retry or Don't add (owner, 2026-10-25). Escape must not
     leave the page under that question. */
  const [couponFailure, setCouponFailure] = useState<{
    ticketId: string;
    created: CreatedTicket;
    input: CreateCouponRequestInput & { id: string };
    error: CouponRequestError;
  } | null>(null);
  const [couponRetrying, setCouponRetrying] = useState(false);
  const couponFailureOpen = useRef(false);
  couponFailureOpen.current = !!couponFailure;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !couponFailureOpen.current) onClose();
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

  /*
   * KEEP THE DRAFT (owner, 2026-10-07). Every change is copied to the tab's
   * sessionStorage, so leaving for another page — or reloading — and coming
   * back finds the ticket as it was left. A form with nothing the agent put
   * there is stored as nothing, so an untouched form never claims to be a
   * restored draft.
   */
  const draftDescription = watch('description') ?? '';
  const draftPriority = watch('priority');
  useEffect(() => {
    if (draftDone.current) return;
    const touched =
      !!draftDescription.trim() ||
      draftPriority !== 'medium' ||
      !!typedOrderId.trim() ||
      assignCoupon ||
      !!collectedCoupon ||
      couponRuleDeclined ||
      (!!storeId && storeId !== inferredStoreId) ||
      !includeOrder ||
      !includeFiles ||
      complaintTouched(complaint, inferredService);
    writeTicketDraft(draftKey, {
      form: touched
        ? {
            description: draftDescription,
            priority: draftPriority,
            complaint,
            typedOrderId,
            lookupId,
            storeId,
            assignCoupon,
            collectedCoupon,
            couponRule,
            couponRuleDeclined,
            includeOrder,
            includeFiles,
          }
        : null,
    });
  }, [
    draftKey,
    draftDescription,
    draftPriority,
    complaint,
    typedOrderId,
    lookupId,
    storeId,
    inferredStoreId,
    inferredService,
    assignCoupon,
    collectedCoupon,
    couponRule,
    couponRuleDeclined,
    includeOrder,
    includeFiles,
  ]);

  /** Cancel is an explicit "I do not want this ticket": the draft goes too. */
  const cancel = () => {
    draftDone.current = true;
    clearTicketDraft(draftKey);
    onClose();
  };

  const sendTicketCoupon = (ticketId: string, input: CreateCouponRequestInput & { id: string }) =>
    raiseTicketCoupon({
      ticketId,
      input,
      send: requestCoupon.mutateAsync,
      markCompensated: (id, value) =>
        updateTicket.mutateAsync({ id, patch: { compensation: value } as never }),
    });

  /** Everything after the save: the pin, the toast, and where to go next. */
  const finishCreated = (created: CreatedTicket, coupon: 'sent' | 'none' | 'skipped') => {
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
    const couponLine =
      coupon === 'sent'
        ? t('coupons.sentForApproval', { defaultValue: 'Coupon sent for approval.' })
        : coupon === 'skipped'
          ? t('coupons.notSent.skipped', { defaultValue: 'No coupon was added.' })
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
  };

  /** The dialog's Retry: the SAME request again (same id). */
  const retryCoupon = async () => {
    if (!couponFailure || couponRetrying) return;
    setCouponRetrying(true);
    const outcome = await sendTicketCoupon(couponFailure.ticketId, couponFailure.input);
    setCouponRetrying(false);
    if (!outcome.ok) {
      setCouponFailure({ ...couponFailure, error: outcome.error });
      return;
    }
    const { created } = couponFailure;
    setCouponFailure(null);
    finishCreated(created, 'sent');
  };

  /** The dialog's Don't add: the ticket stays Not Compensated, as saved. */
  const skipCoupon = () => {
    if (!couponFailure) return;
    const { created } = couponFailure;
    setCouponFailure(null);
    finishCreated(created, 'skipped');
  };

  const onSubmit = handleSubmit(async (values) => {
    if (!contactId || !vendorId) return;
    if (complaintHasErrors(complaint) || !subject) return;
    if (assignCoupon && !collectedCoupon) return; // see couponPromisedNotCreated
    try {
      // The description stays the agent's OWN words. The order rides along as
      // structured JSON so the ticket can render it as a real order card
      // instead of a wall of pasted text.
      const description = values.description?.trim() || undefined;

      // The coupon is withheld from the ticket and sent for approval instead.
      // Writing it now and asking after would make the supervisor's decision a
      // formality applied to money the customer has already been promised.
      const coupon = splitCouponForApproval(complaint);
      /* The coupon request that will go out with this ticket, if any - worked
         out BEFORE the ticket is written, because the ticket's Compensation
         field must say whether one exists (owner, 2026-10-21: "only when a
         coupon is issued the compensated should be there"). The SAME mapping
         the coupon dialog uses, so `delivery_excluded` is never dropped. */
      /* A PRE-FILLED coupon was built before the customer or the branch may
         have been chosen: it takes the form's current ones, exactly as the
         dialog does when it opens. */
      const toSend: CouponRequestDraft | null =
        collectedCoupon && couponRule
          ? {
              ...collectedCoupon,
              title: collectedCoupon.title || contact.data?.phone || '',
              brand_id: chosenMatch?.store?.brandYijiName?.trim() || chosenMatch?.brandName || null,
              restaurant_id: chosenMatch?.store?.yijiRestaurantId || null,
            }
          : collectedCoupon;
      const fullCoupon = toSend ? couponTermsFromDraft(toSend) : null;
      const request = fullCoupon ?? coupon.request;

      const created = await createFromChat.mutateAsync({
        ticket: {
          subject,
          description,
          priority: values.priority,
          contact: contactId,
          vendor: vendorId,
          /*
           * The customer's number AS IT STOOD when the ticket was raised.
           *
           * Deliberately kept even though a contact is always linked now
           * (owner, 2026-09-16). The contact is the living record — corrected,
           * merged, sometimes relinked — and this is the number the agent was
           * actually given on the day. When the two disagree later, that
           * difference is the useful thing, not a contradiction: every reader
           * goes through `customerPhone()`, which prefers the contact, so this
           * never competes for the display.
           */
          customer_phone: contact.data?.phone ?? null,
          conversation: conversationId ?? null,
          assigned_agent: user?.id ?? null,
          order_snapshot: includeOrder && latestOrder ? orderSnapshot(latestOrder) : null,
          // Lifted out of the snapshot so it is searchable: Directus cannot
          // filter inside a json column, so an order id that lives only in
          // order_snapshot cannot be looked up from the inbox search box.
          order_id:
            includeOrder && latestOrder ? String(latestOrder.orderId) : unverifiedOrderId || null,
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
          /* NOT Compensated yet, even with a coupon (owner, 2026-10-25): it
             becomes Compensated once the coupon request row EXISTS - see
             raiseTicketCoupon. Without a coupon this is what it always was. */
          compensation: compensationFlag(false),
        },
        attachmentFileIds: includeFiles ? sessionFileIds : [],
        storeNotifyTypes: notifyTypes.data ?? [],
      });
      // The ticket exists, so the draft has done its job — whatever happens to
      // the coupon below, a reload must not offer to file it a second time.
      draftDone.current = true;
      clearTicketDraft(draftKey);

      // Raised AFTER the ticket, because the request has to point at one. If it
      // fails the ticket still stands, Not Compensated, and the agent has to
      // answer a dialog that says why - the alternative is a promise nobody
      // is holding.
      if (request && created?.id) {
        const input: CreateCouponRequestInput & { id: string } = {
          ...request,
          /* Made once, here: every retry - automatic or the dialog's - sends
             this same id, so the coupon can never be created twice. */
          id: newCouponRequestId(),
          ticket: created.id,
          contact: contactId,
          requested_by: user?.id ?? null,
          reason:
            collectedCoupon?.compensation_reason?.trim() ||
            (couponRule ? description : undefined) ||
            complaint.response_desc?.trim() ||
            null,
          /* The rule it came from and whether the agent changed it - only when
             a rule was involved (owner, 2026-10-27). */
          ...(fullCoupon ? policyFields(couponRule, collectedCoupon) : {}),
        };
        const outcome = await sendTicketCoupon(created.id, input);
        if (!outcome.ok) {
          setCouponFailure({ ticketId: created.id, created, input, error: outcome.error });
          return; // the dialog finishes the save
        }
        finishCreated(created, 'sent');
        return;
      }
      finishCreated(created, 'none');
    } catch {
      toast.error(t('tickets.createError'));
    }
  });

  const hasChatContext = !!conversationId && (!!latestOrder || sessionFileIds.length > 0);
  /*
   * EVERY TICKET HAS A CUSTOMER RECORD BEHIND IT.
   *
   * This briefly accepted a bare typed number instead, because a walk-in with
   * no contacts row could not raise a ticket at all — the picker searched, found
   * nothing, and the button stayed dead (owner, 2026-09-15). The number on the
   * ticket fixed the dead end but left identity in two places.
   *
   * The picker now creates the customer when the number matches nobody
   * (owner, 2026-09-16), so there is always a contact by the time we get here
   * and the check is simply: do we know who this is?
   */
  const hasCustomer = !!contactId;
  /*
   * EVERY TICKET NAMES A BRANCH (owner, 2026-09-28: "not be allowed to create a
   * ticket without the branch").
   *
   * It was optional, and a ticket saved without one DISAPPEARED: the ticket
   * breakdown report filters on completeness, so a branchless ticket was
   * dropped from the report with no error and no row — it simply did not exist
   * as far as operations could see. That is this codebase's recurring failure
   * shape, and it already cost a real investigation into a "missing"
   * late_preparation ticket that had been created all along with `store: null`.
   *
   * Safe to demand because the picker is ALWAYS rendered and lists every
   * branch, so there is no dead end for a walk-in with no order to infer one
   * from — unlike the customer check, which once blocked exactly that.
   */
  const hasStore = !!chosenMatch?.store?.id;
  /* "Assign a coupon" ticked but no coupon created (owner, 2026-10-21): the
     ticket used to save as Compensated with NO coupon behind it, silently -
     Nada's two tickets for 0571664749. The box is a promise; it must be kept
     (create the coupon) or withdrawn (untick it) before saving. */
  const couponPromisedNotCreated = assignCoupon && !collectedCoupon;
  const canSubmit =
    hasCustomer &&
    !!vendorId &&
    !complaintHasErrors(complaint) &&
    !!subject &&
    hasStore &&
    !couponPromisedNotCreated;

  // Identify the ticket by who and what it is about, not by restating the
  // page's purpose. Empty on a blank standalone form, where the generic hint
  // is still the most useful thing to say.
  const contextLine = [
    // First, because it is what the ticket will be CALLED. With no subject box
    // on the form, this is the only place the agent sees the name they are
    // about to give it.
    subject ? optionLabel(subject) : null,
    // A name that is really the phone reads as the canonical 05 number.
    displayContactName(contact.data?.name, contact.data?.phone) || null,
    latestOrder ? `#${latestOrder.orderId}` : null,
    chosenMatch?.store ? chosenMatch.restaurantName : null,
  ].filter((v): v is string => !!v);

  const blockedReason = !hasCustomer
    ? t('tickets.pickCustomer', {
        defaultValue: 'Find the customer by phone number or name',
      })
    : !subject
      ? // Named, not vague: "check the highlighted fields" sends the agent
        // hunting across a fourteen-field form for the one thing missing.
        t('tickets.pickComplaintType', {
          defaultValue: 'Choose a ticket type — it names the ticket',
        })
      : !hasStore
        ? /* Named like the others, and it says WHY: an agent told only "pick a
             branch" has no reason to believe it matters, and this one decides
             whether the ticket is ever counted. */
          t('tickets.pickStore', {
            defaultValue: 'Choose the branch — reports are grouped by it',
          })
        : complaintHasErrors(complaint)
          ? t('tickets.fixFieldsFirst', { defaultValue: 'Check the highlighted fields' })
          : couponPromisedNotCreated
            ? t('tickets.couponNotCreated', {
                defaultValue: 'Create the coupon, or untick "Assign a coupon"',
              })
            : '';

  return (
    <form
      onSubmit={onSubmit}
      // The near-black canvas, not a full-bleed sheet: the two form halves are
      // elevated cards now, and cards need ground to float off.
      /* ONE SCROLL, THE PAGE'S (owner, 2026-10-25): no card scrolls inside
         itself any more - the form is as tall as its content and the page
         around it (NewTicketPage) scrolls. */
      className="flex min-h-full flex-col bg-background"
      noValidate
    >
      {/* One header, not a back-strip stacked on a title bar. Save stays
          reachable from anywhere without scrolling to find it: the header
          sticks to the top of the page scroll. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-5 gap-y-3 bg-background px-5 pb-2 pt-5 sm:px-7">
        {backLabel && (
          <button
            type="button"
            onClick={onClose}
            aria-label={backLabel}
            title={backLabel}
            className="agent-icon-btn shrink-0 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:active:scale-[0.97]"
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
          {/* A restored draft is restored SILENTLY (owner, 2026-10-25: no
              "Draft restored" strip); starting clean stays one press away. */}
          {draftRestored && (
            <Button type="button" variant="ghost" size="md" onClick={onDiscardDraft}>
              {t('tickets.draftClear', { defaultValue: 'Clear draft' })}
            </Button>
          )}
          <Button type="button" variant="ghost" size="md" onClick={cancel}>
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
      <div className="flex flex-1 flex-col lg:flex-row lg:items-start">
        {/* Columns sized to the fields rather than to the monitor, and centred
            in whatever is left. Two 50% columns on a 1920 screen put 640px of
            inputs against a 300px empty gutter each, which reads as a layout
            that failed rather than one that chose. 42.5rem exactly: the
            sections cap their fields at 40rem and pad 1.25rem a side, so a
            wider column just re-opens a ragged gutter inside the card. */}
        <div className="mx-auto grid w-full max-w-[85rem] flex-1 grid-cols-1 items-start gap-5 p-5 sm:p-6 lg:grid-cols-2">
          <div>
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
                {/* THE ORDER, typed in.
                    Shown only when there is no order already — from a chat the
                    order comes with the conversation and this would invite an
                    agent to override it by hand. On the Add-ticket page there
                    is nothing else, and without it the ticket carries no order:
                    a coupon on such a ticket can never be delivered, because
                    Yiji attaches coupons TO AN ORDER. */}
                {!latestOrder && (
                  <FormField
                    label={
                      walkInService
                        ? t('complaint.restaurantOrderId', {
                            defaultValue: 'Restaurant order no. (optional)',
                          })
                        : t('complaint.orderId', { defaultValue: 'Order number (optional)' })
                    }
                    hint={
                      walkInService
                        ? t('complaint.orderIdWalkInHint', {
                            defaultValue:
                              'Takeout and Dine-in: type the number on the restaurant receipt. It is recorded as given — there is nothing to look up.',
                          })
                        : typedOrderQuery.isError
                          ? undefined
                          : t('complaint.orderIdHint', {
                              defaultValue:
                                'For reference only. A coupon is always sent to the customer’s phone number, never to an order.',
                            })
                    }
                    /* A walk-in receipt number is NOT a Yiji order id, so a
                       lookup against it can only ever fail. Showing "no order
                       with that number" for Takeout/Dine-in told the agent
                       their perfectly good number was wrong. */
                    error={
                      !walkInService && typedOrderQuery.isError
                        ? t('complaint.orderNotFound', {
                            defaultValue: 'No order with that number for this vendor.',
                          })
                        : undefined
                    }
                  >
                    <div className="flex gap-2">
                      <input
                        value={typedOrderId}
                        onChange={(e) => setTypedOrderId(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          // Enter looks up rather than submitting the ticket —
                          // a half-filled form saved by a stray keypress is
                          // worse than a button nobody found.
                          if (e.key === 'Enter') {
                            // Never submits the ticket; and for a walk-in there
                            // is nothing to look up, so it simply does nothing.
                            e.preventDefault();
                            if (!walkInService) setLookupId(typedOrderId.trim());
                          }
                        }}
                        inputMode="numeric"
                        aria-label={t('complaint.orderId', {
                          defaultValue: 'Order number (optional)',
                        })}
                        placeholder={t('complaint.orderIdPlaceholder', {
                          defaultValue: 'e.g. 1234535',
                        })}
                        className="h-10 min-w-[8rem] flex-1 rounded-2xl bg-input px-3.5 font-mono text-sm tabular-nums text-foreground ring-1 ring-inset ring-foreground/[0.08] placeholder:font-sans placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      />
                      {/* NO FIND FOR A WALK-IN.
                          Takeout and Dine-in customers read out the number on
                          the restaurant's own receipt, which the Yiji lookup
                          cannot resolve — so the button could only ever fail,
                          and offering it invited the agent to keep pressing it
                          (owner, 2026-09-15). The number is taken as typed. */}
                      {!walkInService && (
                        <Button
                          type="button"
                          variant="ghost"
                          loading={typedOrderQuery.isFetching}
                          disabled={!typedOrderId.trim() || !yijiVendorId}
                          onClick={() => setLookupId(typedOrderId.trim())}
                        >
                          {t('commerce.lookupGo', { defaultValue: 'Find' })}
                        </Button>
                      )}
                    </div>
                  </FormField>
                )}
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
          <div>
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
                <p className="flex items-start gap-2.5 rounded-2xl bg-warning-tint px-3.5 py-2.5 text-xs leading-relaxed text-foreground">
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
              {/* `request_coupons` (owner, 2026-10-06). */}
              {canRequestCoupon && (
                <div className="rounded-2xl bg-primary/[0.05] p-4 ring-1 ring-inset ring-primary/15">
                  <label className="flex items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={assignCoupon}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setAssignCoupon(on);
                        if (!on) {
                          setCollectedCoupon(null);
                          /* Switching a rule's suggestion off is final for
                             this form: it is not pre-filled again. */
                          if (couponRule) setCouponRuleDeclined(true);
                          setCouponRule(null);
                        }
                        // The compensation flag follows the box, so the agent is
                        // never asked the same thing twice.
                        setComplaint((c) => ({ ...c, compensation: compensationFlag(on) }));
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground">
                        {t('coupons.assign', { defaultValue: 'Assign a coupon' })}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {t('coupons.assignHint', {
                          defaultValue:
                            'A supervisor approves it before anything reaches the customer.',
                        })}
                      </span>
                    </span>
                  </label>
                  <div className="mt-3.5 flex flex-wrap items-center gap-3 ps-[1.625rem]">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!assignCoupon}
                      onClick={() => setCouponOpen(true)}
                    >
                      {t('coupons.create', { defaultValue: 'Create coupon' })}
                    </Button>
                    {collectedCoupon && (
                      <span className="text-xs font-semibold text-success-foreground">
                        {t('coupons.attached', {
                          code: collectedCoupon.code,
                          defaultValue: '{{code}} will be sent for approval',
                        })}
                      </span>
                    )}
                  </div>
                  {/* THE POLICY behind a pre-filled coupon (owner, 2026-10-27):
                      which rule, and whether the agent changed it. */}
                  {couponRule && collectedCoupon && (
                    <p
                      data-testid="coupon-rule-line"
                      className="mt-2.5 flex flex-wrap items-center gap-2 ps-[1.625rem] text-xs text-muted-foreground"
                    >
                      <span>
                        {t('coupons.prefilledFrom', {
                          defaultValue:
                            'Pre-filled from the rule "{{name}}". Accept it, adjust it with Create coupon, or untick to send none.',
                          name: couponRule.name,
                        })}
                      </span>
                      {couponAdjusted && (
                        <Pill tone="warning" size="sm" dot>
                          {t('coupons.differsPill', { defaultValue: 'Differs from policy' })}
                        </Pill>
                      )}
                    </p>
                  )}
                  {ruleLimit.data?.reached && (
                    <p className="mt-2.5 ps-[1.625rem] text-xs text-muted-foreground">
                      {t('coupons.ruleLimitReached', {
                        defaultValue:
                          'This customer already had {{max}} rule coupon(s) in the last {{days}} days, so nothing was pre-filled. You can still create one by hand.',
                        max: ruleLimit.data.limit?.maxPerCustomer ?? '',
                        days: ruleLimit.data.limit?.windowDays ?? '',
                      })}
                    </p>
                  )}
                </div>
              )}
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
                    ? latestOrder.items.map((it) => ({
                        name: it.name,
                        price: it.price ?? null,
                        // The quantity too: `price` is the price of ONE, so the
                        // picker needs both to fill the coupon with what the
                        // LINE cost (owner, 2026-09-29).
                        qty: it.qty ?? null,
                        // Yiji's item id, so a picked item is recorded by a key
                        // that has no spellings — see `item_sku`.
                        sku: it.sku ?? null,
                      }))
                    : []
                }
                requestedBy={user?.id ?? null}
                onCollect={setCollectedCoupon}
                prefill={couponRule ? collectedCoupon : null}
                policy={
                  couponRule ? { name: couponRule.name, suggested: couponRule.suggested } : null
                }
              />
              <ComplaintResolution
                values={complaint}
                onChange={(patch) => setComplaint((c) => ({ ...c, ...patch }))}
                hideCoupon
              />
              {/* Said while the agent is still typing the coupon, not after
                  they have told the customer about it. */}
              {needsApproval && (
                <p className="flex items-start gap-2.5 rounded-2xl bg-primary/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-foreground">
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
      {/* Blocking until answered: the ticket is saved, the coupon is not. */}
      <CouponNotSentDialog
        open={!!couponFailure}
        kind={couponFailure?.error.kind ?? 'unknown'}
        status={couponFailure?.error.status ?? null}
        detail={couponFailure?.error.detail ?? null}
        retrying={couponRetrying}
        onRetry={() => void retryCoupon()}
        onSkip={skipCoupon}
      />
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
    <aside className="w-full shrink-0 border-t border-border bg-card px-6 py-5 lg:my-5 lg:me-5 lg:w-[20rem] lg:rounded-[1.625rem] lg:border-t-0 lg:shadow-[var(--agent-card-shadow)]">
      {/* Same head as the form sections, in the fourth hue — the tinted chip
          with the sky dot — so the rail reads as a peer of the columns rather
          than a stray panel. */}
      <header className="mb-4 flex items-center gap-2.5">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sky-tint"
          aria-hidden
        >
          <span className="h-1.5 w-1.5 rounded-full bg-sky" />
        </span>
        <h2 className="text-md font-semibold tracking-[-0.01em] text-foreground">
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
