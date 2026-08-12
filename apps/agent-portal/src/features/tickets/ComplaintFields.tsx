import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, FormField, Input, Spinner, Textarea } from '@yiji/ui';
import {
  CommunicationMethod,
  Compensation,
  ComplaintSource,
  ComplaintType,
  DEFAULT_COMMUNICATION_METHOD,
  ServiceType,
} from '@yiji/shared-types';
import type { TicketOrderSnapshot } from './OrderSnapshotCard.js';
import { useStores, type StoreRow } from './useStoreMatch.js';

/**
 * The operations manager's "New Complaint" fields, shared by the two places a
 * ticket is raised (from a chat, and standalone) so the form is defined once.
 *
 * Layout follows his app: three titled sections — Order & location / What
 * happened / Resolution — rather than one flat column of inputs. Agents who
 * have used his tool find the fields where they expect them.
 *
 * Every field is OPTIONAL. Not every ticket is a complaint (the inbox still
 * raises ordinary support tickets), and a guessed complaint_type is worse than
 * a blank one because it lands in a report that reads as fact.
 */

/** The complaint fields, exactly as they are stored on `tickets`. */
export interface ComplaintValues {
  /** `datetime-local` value — when the complaint HAPPENED, not when it was typed. */
  complaint_date: string;
  complaint_type: string;
  service_type: string;
  complaint_source: string;
  communication_method: string;
  response_desc: string;
  compensation: string;
  coupon_code: string;
  coupon_value: string;
  coupon_percent: string;
}

/**
 * `YYYY-MM-DDTHH:mm` in LOCAL time, the only format `datetime-local` accepts.
 * toISOString would hand it UTC and the field would show the wrong clock.
 */
export function nowLocalInput(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(
    at.getMinutes(),
  )}`;
}

/** A stored ISO timestamp back into the form's `datetime-local` value. */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : nowLocalInput(d);
}

export const emptyComplaint: ComplaintValues = {
  complaint_date: '',
  complaint_type: '',
  service_type: '',
  complaint_source: '',
  communication_method: '',
  response_desc: '',
  compensation: '',
  coupon_code: '',
  coupon_value: '',
  coupon_percent: '',
};

/**
 * Starting values for a ticket raised FROM A CONVERSATION.
 *
 * The agent is answering inside the CRM, so the communication method is not a
 * guess — it is the only thing it can be, and making the agent pick it from a
 * list would just invite a wrong answer. A ticket created standalone keeps
 * `emptyComplaint`: with no conversation behind it the channel really is
 * unknown, and defaulting it there would file phone-backs as CRM replies.
 */
export const complaintFromConversation: ComplaintValues = {
  ...emptyComplaint,
  communication_method: DEFAULT_COMMUNICATION_METHOD,
};

/**
 * Turn the form's strings into the payload Directus stores: blanks become
 * `null` (an empty string would be a value that means "not answered", and it
 * would show up in reports as its own category), and the two coupon numbers
 * become real numbers so the compensation total can be summed in SQL.
 */
export function complaintPatch(v: ComplaintValues): Record<string, string | number | null> {
  const str = (s: string) => (s.trim() ? s.trim() : null);
  const num = (s: string) => {
    const n = Number(s.trim());
    return s.trim() && Number.isFinite(n) ? n : null;
  };
  return {
    // `datetime-local` is wall-clock with no zone. new Date() reads it as
    // LOCAL time, which is what the agent meant, and toISOString then stores
    // the right instant. Parsing it as UTC would shift every complaint by the
    // offset and quietly move some across midnight into the wrong day.
    complaint_date: v.complaint_date.trim()
      ? (() => {
          const d = new Date(v.complaint_date);
          return Number.isNaN(d.getTime()) ? null : d.toISOString();
        })()
      : null,
    complaint_type: str(v.complaint_type),
    service_type: str(v.service_type),
    complaint_source: str(v.complaint_source),
    communication_method: str(v.communication_method),
    response_desc: str(v.response_desc),
    compensation: str(v.compensation),
    coupon_code: str(v.coupon_code),
    coupon_value: num(v.coupon_value),
    coupon_percent: num(v.coupon_percent),
  };
}

/**
 * The stored values are the operations team's own spellings, typos and all
 * ("Comp. Twiter", "Dinning") — see the note on ComplaintType in shared-types.
 * Those must never change, so this maps the awkward ones to something readable
 * for display ONLY. Anything not listed shows exactly as stored.
 */
const DISPLAY: Record<string, string> = {
  'Comp. WhatsApp': 'WhatsApp',
  'Comp. Phone Call': 'Phone call',
  'Comp. Twiter': 'X (Twitter)',
  'Comp.Instgram': 'Instagram',
  'WeCare Channels': 'WeCare channels',
  'AFCO APP': 'Yiji app',
  Dinning: 'Dine-in',
  TakeOut: 'Take-away',
  'Instore preparation late order': 'Late preparation in store',
  'Order Late in store': 'Late collection in store',
};

/** Display label for a stored option value. */
export function optionLabel(value: string): string {
  return DISPLAY[value] ?? value;
}

/**
 * `Delivery`, `Pickup` … inferred from the order snapshot's delivery type, so
 * the agent is not retyping something the order already knows. Only used to
 * PRE-FILL — the agent can always override it, because the order's fulfilment
 * and the thing being complained about are not always the same.
 */
export function serviceTypeFromOrder(order: TicketOrderSnapshot | null | undefined): string {
  const d = order?.deliveryType?.toLowerCase().replace(/[\s_-]/g, '');
  if (!d) return '';
  if (d.includes('deliver')) return 'Delivery';
  if (d.includes('pickup') || d.includes('collect')) return 'Pickup';
  if (d.includes('takeaway') || d.includes('takeout')) return 'TakeOut';
  if (d.includes('drivethru') || d.includes('drivethrough')) return 'Drive Thru';
  if (d.includes('din') || d.includes('instore') || d.includes('eatin')) return 'Dinning';
  return '';
}

/* ── Combobox ──────────────────────────────────────────────────────────────
 *
 * His dropdowns are type-to-filter and LOCKED to the list: you can narrow by
 * typing, but you cannot invent a value — that is what keeps a category from
 * fragmenting into six spellings across 1,673 rows. Reproduced here because
 * Directus's `choices` are UI metadata only (the API happily accepts an
 * off-list string), so the portal is the real enforcement point.
 */
function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  invalid,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  placeholder?: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // What the agent has typed. Null means "not typing" — show the selection.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return options;
    // Match the stored value AND the display label, so typing "whatsapp" finds
    // "Comp. WhatsApp" and typing "dine" finds "Dinning".
    return options.filter(
      (o) => o.toLowerCase().includes(q) || optionLabel(o).toLowerCase().includes(q),
    );
  }, [options, query]);

  // Close on an outside click; typing is abandoned rather than committed, which
  // is what makes the field impossible to leave holding an off-list value.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const commit = (v: string) => {
    onChange(v);
    setQuery(null);
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        invalid={invalid}
        placeholder={placeholder}
        value={query ?? optionLabel(value)}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => {
              const n = filtered.length;
              if (!n) return 0;
              return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
            });
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            const pick = filtered[active];
            if (pick) commit(pick);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation(); // don't also close the dialog
            setOpen(false);
            setQuery(null);
          } else if (e.key === 'Backspace' && query === null && value) {
            // First keystroke on a filled field clears it, so re-picking is one
            // gesture rather than select-all-then-type.
            e.preventDefault();
            commit('');
          }
        }}
        className="pe-8"
      />
      {/* Clear — the fields are optional, so getting back to "not answered"
          must be possible without emptying the box character by character. */}
      {value && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => commit('')}
          aria-label={t('actions.clear', { ns: 'common', defaultValue: 'Clear' })}
          className="absolute end-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-fast hover:text-foreground"
        >
          <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl bg-card p-1 shadow-float ring-1 ring-foreground/[0.08]"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {t('tickets.noOption', { defaultValue: 'No matching option.' })}
            </li>
          ) : (
            filtered.map((o, i) => (
              <li key={o}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(o)}
                  className={cn(
                    'block w-full rounded-lg px-3 py-1.5 text-start text-sm transition-colors duration-fast',
                    i === active ? 'bg-secondary text-foreground' : 'text-foreground/85',
                    o === value && 'font-semibold',
                  )}
                >
                  {optionLabel(o)}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/* ── Branch picker ─────────────────────────────────────────────────────────
 *
 * His restaurant field is THE locked autocomplete in his app: type a few
 * letters, pick from the master list, and Area / City / Brand / Chain fill in
 * from that branch's record. Same thing here, over our `stores` collection.
 *
 * It is a separate control from the option comboboxes above because a branch is
 * a ROW, not a string: it is stored as an id (`tickets.store`), searched across
 * code + name + city, and its city/managers are shown once chosen so the agent
 * can confirm they picked the right one of several similarly-named branches.
 */

/** "LCP-002 Marina Mall 2" — how operations say a branch out loud. */
export function storeLabel(s: StoreRow): string {
  return [s.code, s.name].filter(Boolean).join(' ');
}

export function StorePicker({
  value,
  onChange,
  /** Where a pre-filled value came from, shown so the agent knows to check it. */
  inferredFrom,
}: {
  value: string;
  onChange: (storeId: string) => void;
  inferredFrom?: string | null;
}) {
  const { t } = useTranslation();
  const stores = useStores();
  const rows = useMemo(() => stores.data ?? [], [stores.data]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  const inputId = useId();

  const selected = rows.find((s) => s.id === value) ?? null;

  const filtered = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    // Cap the unfiltered list: 134 branches in one popover is a scroll, not a
    // choice. Typing is the intended interaction, exactly as in his app.
    if (!q) return rows.slice(0, 50);
    return rows
      .filter((s) =>
        [s.code, s.name, s.city, s.brand?.code].some((f) => f?.toLowerCase().includes(q)),
      )
      .slice(0, 50);
  }, [rows, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const commit = (id: string) => {
    onChange(id);
    setQuery(null);
    setOpen(false);
  };

  // His auto-fill: the branch's own record answers city / area / chain, so the
  // agent never types them and they cannot disagree with the master list.
  const detail = selected
    ? [
        selected.brand?.code,
        selected.city,
        selected.area_manager &&
          `${t('complaint.area', { defaultValue: 'Area' })}: ${selected.area_manager}`,
        selected.chain_manager &&
          `${t('complaint.chain', { defaultValue: 'Chain' })}: ${selected.chain_manager}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <FormField
      label={t('complaint.branch', { defaultValue: 'Restaurant / branch' })}
      htmlFor={inputId}
      hint={
        detail ||
        (inferredFrom
          ? t('complaint.branchInferred', {
              defaultValue: 'From the order — change it if the complaint is about another branch.',
            })
          : t('complaint.branchHint', {
              defaultValue: 'Search by code, name or city.',
            }))
      }
    >
      <div ref={wrap} className="relative">
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={
            stores.isLoading
              ? t('actions.loading', { ns: 'common', defaultValue: 'Loading' })
              : t('complaint.branchSearch', { defaultValue: 'Type to search branches…' })
          }
          value={query ?? (selected ? storeLabel(selected) : '')}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => {
                const n = filtered.length;
                if (!n) return 0;
                return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
              });
            } else if (e.key === 'Enter' && open) {
              e.preventDefault();
              const pick = filtered[active];
              if (pick) commit(pick.id);
            } else if (e.key === 'Escape' && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setQuery(null);
            } else if (e.key === 'Backspace' && query === null && value) {
              e.preventDefault();
              commit('');
            }
          }}
          className="pe-8"
        />
        {value && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => commit('')}
            aria-label={t('actions.clear', { ns: 'common', defaultValue: 'Clear' })}
            className="absolute end-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        {open && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl bg-card p-1 shadow-float ring-1 ring-foreground/[0.08]"
          >
            {stores.isLoading ? (
              <li className="flex justify-center py-4">
                <Spinner size={16} />
              </li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                {/* Agents cannot add a branch — that is operations master data,
                    maintained in the admin portal. Say so, rather than letting
                    them type a name that would never match a real store. */}
                {rows.length === 0
                  ? t('complaint.noStores', { defaultValue: 'Branch list unavailable.' })
                  : t('complaint.noBranch', {
                      defaultValue: 'No branch matches. Ask an admin to add it.',
                    })}
              </li>
            ) : (
              filtered.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={s.id === value}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(s.id)}
                    className={cn(
                      'block w-full rounded-lg px-3 py-1.5 text-start transition-colors duration-fast',
                      i === active ? 'bg-secondary' : '',
                    )}
                  >
                    <span
                      className={cn(
                        'block text-sm text-foreground',
                        s.id === value && 'font-semibold',
                      )}
                    >
                      {storeLabel(s)}
                    </span>
                    {(s.city || s.brand?.code) && (
                      <span className="block text-2xs text-muted-foreground">
                        {[s.brand?.code, s.city].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </FormField>
  );
}

/** One titled group of fields — his "Order & location" / "Complaint Details" cards. */
/**
 * Each section owns a hue, carried by a single dot.
 *
 * Colour as an accent, never as a surface (DESIGN.md): the card stays white so
 * it floats off the tinted canvas, and the dot is what tells the three columns
 * apart at a glance. A tinted section fill was the first attempt and read as a
 * wireframe, which is the same failure the KPI tiles went through.
 */
const SECTION_DOT = {
  primary: 'bg-primary',
  violet: 'bg-violet',
  success: 'bg-success',
  sky: 'bg-sky',
} as const;

export function ComplaintSection({
  title,
  tone = 'primary',
  hint,
  divider = false,
  children,
}: {
  title: string;
  tone?: keyof typeof SECTION_DOT;
  /** Quiet counterweight on the title line: a count, or what the section is for. */
  hint?: string;
  /** Hairline against the previous column. Omitted on the first. */
  divider?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'px-6 py-5',
        // A hairline, not a box. Four bordered-and-shadowed panels is the
        // "drop shadows on every panel" admin template PRODUCT.md names as an
        // anti-reference, and it turns one task into four things to look at.
        // The rule separates just as well and disappears while reading.
        divider && 'border-t border-border',
      )}
    >
      {/* Not an uppercase eyebrow: the field labels below are already uppercase
          and tracked, so a second caps size stacked above them reads as noise
          rather than hierarchy. Weight plus the hue dot carry it. */}
      <header className="mb-4 flex items-baseline gap-2">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', SECTION_DOT[tone])} aria-hidden />
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {hint && <span className="ms-auto shrink-0 text-2xs text-muted-foreground">{hint}</span>}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * "What happened" — the classification half of his Complaint Details section.
 * `subject`/`description` stay with the caller because they already exist on
 * both dialogs and differ in how they are wired (RHF vs local state).
 */
export function ComplaintClassification({
  values,
  onChange,
}: {
  values: ComplaintValues;
  onChange: (patch: Partial<ComplaintValues>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      {/* First field in the section: every ops report groups and filters by
          this date, and it is the one thing the agent cannot recover later if
          they leave it wrong. */}
      <FormField
        label={t('complaint.date', { defaultValue: 'Complaint date' })}
        hint={t('complaint.dateHint', { defaultValue: 'When it happened' })}
      >
        <Input
          type="datetime-local"
          value={values.complaint_date}
          max={nowLocalInput()}
          onChange={(e) => onChange({ complaint_date: e.target.value })}
        />
      </FormField>
      <FormField label={t('complaint.type', { defaultValue: 'Complaint type' })}>
        <Combobox
          value={values.complaint_type}
          onChange={(v) => onChange({ complaint_type: v })}
          options={ComplaintType.options}
          placeholder={t('complaint.search', { defaultValue: 'Type to search…' })}
        />
      </FormField>
      <FormField label={t('complaint.serviceType', { defaultValue: 'Service type' })}>
        <Combobox
          value={values.service_type}
          onChange={(v) => onChange({ service_type: v })}
          options={ServiceType.options}
          placeholder={t('complaint.search', { defaultValue: 'Type to search…' })}
        />
      </FormField>
      <FormField
        label={t('complaint.source', { defaultValue: 'Complaint source' })}
        hint={t('complaint.sourceHint', { defaultValue: 'Where it came in' })}
      >
        <Combobox
          value={values.complaint_source}
          onChange={(v) => onChange({ complaint_source: v })}
          options={ComplaintSource.options}
          placeholder={t('complaint.search', { defaultValue: 'Type to search…' })}
        />
      </FormField>
      <FormField
        label={t('complaint.communication', { defaultValue: 'Communication method' })}
        hint={t('complaint.communicationHint', { defaultValue: 'How you replied' })}
      >
        <Combobox
          value={values.communication_method}
          onChange={(v) => onChange({ communication_method: v })}
          options={CommunicationMethod.options}
          placeholder={t('complaint.search', { defaultValue: 'Type to search…' })}
        />
      </FormField>
    </div>
  );
}

/**
 * "Resolution" — what was done and what it cost. The coupon inputs stay visible
 * whatever `compensation` says: agents log the coupon first and set the status
 * afterwards at least as often as the other way round, and hiding the inputs
 * behind the dropdown would lose whatever they had already typed.
 */
export function ComplaintResolution({
  values,
  onChange,
}: {
  values: ComplaintValues;
  onChange: (patch: Partial<ComplaintValues>) => void;
}) {
  const { t } = useTranslation();
  // Only a real digit-entry mistake is worth interrupting for; blank is fine.
  const percent = Number(values.coupon_percent);
  const badPercent =
    values.coupon_percent.trim() !== '' &&
    (!Number.isFinite(percent) || percent < 0 || percent > 100);
  const value = Number(values.coupon_value);
  const badValue = values.coupon_value.trim() !== '' && (!Number.isFinite(value) || value < 0);

  return (
    <div className="space-y-3.5">
      <FormField label={t('complaint.response', { defaultValue: 'Resolution notes' })}>
        <Textarea
          rows={2}
          dir="auto"
          value={values.response_desc}
          onChange={(e) => onChange({ response_desc: e.target.value })}
          placeholder={t('complaint.responsePlaceholder', {
            defaultValue: 'What you did about it…',
          })}
        />
      </FormField>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label={t('complaint.compensation', { defaultValue: 'Compensation' })}>
          <Combobox
            value={values.compensation}
            onChange={(v) => onChange({ compensation: v })}
            options={Compensation.options}
            placeholder={t('complaint.search', { defaultValue: 'Type to search…' })}
          />
        </FormField>
        <FormField label={t('complaint.couponCode', { defaultValue: 'Coupon code' })}>
          <Input
            value={values.coupon_code}
            autoComplete="off"
            onChange={(e) => onChange({ coupon_code: e.target.value })}
          />
        </FormField>
        <FormField
          label={t('complaint.couponValue', { defaultValue: 'Coupon value (SAR)' })}
          error={
            badValue
              ? t('complaint.badValue', { defaultValue: 'Enter an amount of 0 or more.' })
              : undefined
          }
        >
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            invalid={badValue}
            value={values.coupon_value}
            onChange={(e) => onChange({ coupon_value: e.target.value })}
          />
        </FormField>
        <FormField
          label={t('complaint.couponPercent', { defaultValue: 'Coupon %' })}
          error={
            badPercent
              ? t('complaint.badPercent', { defaultValue: 'Enter a percentage between 0 and 100.' })
              : undefined
          }
        >
          <Input
            type="number"
            min={0}
            max={100}
            step="1"
            inputMode="decimal"
            invalid={badPercent}
            value={values.coupon_percent}
            onChange={(e) => onChange({ coupon_percent: e.target.value })}
          />
        </FormField>
      </div>
    </div>
  );
}

/** True when either coupon number is out of range — callers block submit on it. */
export function complaintHasErrors(v: ComplaintValues): boolean {
  const pct = Number(v.coupon_percent);
  const val = Number(v.coupon_value);
  return (
    (v.coupon_percent.trim() !== '' && (!Number.isFinite(pct) || pct < 0 || pct > 100)) ||
    (v.coupon_value.trim() !== '' && (!Number.isFinite(val) || val < 0))
  );
}
