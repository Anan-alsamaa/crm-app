import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  Button,
  cn,
  EmptyState,
  FormField,
  Input,
  Pill,
  Select,
  Skeleton,
  Textarea,
  toast,
} from '@yiji/ui';
import {
  useCompensationRequests,
  useCompensationRequest,
  useCompensationItems,
  useTriggerCompensationFlow,
  useComIssues,
  useComplaintCategories,
  useUpdateRequest,
  COMPENSATION_STATUSES,
  type CompensationRow,
  type CompensationStatus,
  type IssueItem,
  type RequestPatch,
} from './api.js';
import {
  COMPENSATION_ACTIONS,
  type CompAction,
  type CompInput,
  type CompLinkType,
} from './actions.js';

const STATUS_TONE: Record<
  CompensationStatus,
  'warning' | 'neutral' | 'primary' | 'success' | 'muted' | 'destructive'
> = {
  Pending: 'warning',
  'In Progress': 'primary',
  Approved: 'success',
  Rejected: 'destructive',
};

const BTN_VARIANT: Record<CompLinkType, 'default' | 'brand' | 'destructive'> = {
  primary: 'default',
  danger: 'destructive',
  success: 'brand',
};

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'SAR' }).format(n);
  } catch {
    return `${n} SAR`;
  }
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function StatusPill({ status }: { status: CompensationStatus }) {
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {status}
    </Pill>
  );
}

/* ── Queue ───────────────────────────────────────────────────────── */

function RequestQueue() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useCompensationRequests();
  const [filter, setFilter] = useState<'all' | CompensationStatus>('all');

  const rows = useMemo(
    () => (data ?? []).filter((r) => filter === 'all' || r.status === filter),
    [data, filter],
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t('compensation.title', { defaultValue: 'Compensation' })}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('compensation.subtitle', {
            defaultValue: 'Review customer compensation requests and run each step.',
          })}
        </p>
      </header>

      {/* Status filter */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['all', ...COMPENSATION_STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors duration-fast',
              filter === s
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground',
            )}
          >
            {s === 'all' ? t('compensation.all', { defaultValue: 'All' }) : s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      ) : isError ? (
        <p className="text-sm text-muted-foreground">
          {t('compensation.loadError', { defaultValue: 'Could not load compensation requests.' })}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('compensation.empty', { defaultValue: 'No compensation requests' })}
          description={t('compensation.emptyHint', {
            defaultValue: 'Requests submitted by customers will appear here.',
          })}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <QueueCard row={r} onOpen={() => navigate(`/compensation/${r.id}`)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueCard({ row, onOpen }: { row: CompensationRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-4 rounded-xl px-4 py-3 text-start transition-colors duration-fast hover:bg-secondary/60"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            {row.request_code ?? row.id.slice(0, 8)}
          </span>
          <StatusPill status={row.status} />
        </div>
        <div className="mt-1 truncate text-sm font-medium text-foreground">
          {row.customer_name ?? row.customer_mobile ?? '—'}
        </div>
        <div className="mt-0.5 truncate text-2xs text-muted-foreground">
          {[row.brand_name, row.restaurant_name].filter(Boolean).join(' · ') || '—'}
          {row.order_id ? ` · #${row.order_id}` : ''}
        </div>
      </div>
      <div className="shrink-0 text-end">
        <div className="text-sm font-semibold tabular-nums text-foreground">
          {money(row.final_compensation_value ?? row.user_complaint_amount)}
        </div>
        <div className="mt-0.5 text-2xs text-muted-foreground tabular-nums">
          {fmtDate(row.date_created).split(',')[0]}
        </div>
      </div>
    </button>
  );
}

/* ── Detail ──────────────────────────────────────────────────────── */

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-end text-xs text-foreground">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-card p-4 shadow-soft">
      <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      <dl>{children}</dl>
    </div>
  );
}

function RequestDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: r, isLoading } = useCompensationRequest(id);
  const { data: items } = useCompensationItems(id);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-6 sm:px-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (!r) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/compensation')}>
          <ArrowLeftIcon size={16} className="rtl:-scale-x-100" />{' '}
          {t('compensation.back', { defaultValue: 'Back' })}
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">
          {t('compensation.notFound', { defaultValue: 'Request not found.' })}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/compensation')}>
          <ArrowLeftIcon size={16} className="rtl:-scale-x-100" />{' '}
          {t('compensation.back', { defaultValue: 'Back' })}
        </Button>
        <span className="font-mono text-sm text-muted-foreground">
          {r.request_code ?? r.id.slice(0, 8)}
        </span>
        <StatusPill status={r.status} />
      </div>

      <ActionPanel request={r} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Section title={t('compensation.customer', { defaultValue: 'Customer' })}>
          <Row
            label={t('compensation.name', { defaultValue: 'Name' })}
            value={r.customer_name ?? '—'}
          />
          <Row
            label={t('compensation.mobile', { defaultValue: 'Mobile' })}
            value={r.customer_mobile ?? '—'}
          />
          <Row label="ID" value={r.customer_id ?? '—'} />
        </Section>
        <Section title={t('compensation.order', { defaultValue: 'Order' })}>
          <Row label="#" value={r.order_id ?? '—'} />
          <Row
            label={t('compensation.brand', { defaultValue: 'Brand' })}
            value={r.brand_name ?? '—'}
          />
          <Row
            label={t('compensation.restaurant', { defaultValue: 'Restaurant' })}
            value={r.restaurant_name ?? '—'}
          />
          <div className="mt-1 space-y-2">
            <EditableAmount
              request={r}
              field="order_total"
              label={t('compensation.orderTotal', { defaultValue: 'Order total (SAR)' })}
            />
            <EditableAmount
              request={r}
              field="delivery_fee"
              label={t('compensation.deliveryFee', { defaultValue: 'Delivery fee (SAR)' })}
              hint={t('compensation.deliveryFeeHint', {
                defaultValue: 'Used by DELIVERY-type compensation rules.',
              })}
            />
          </div>
        </Section>
        <Section title={t('compensation.complaint', { defaultValue: 'Complaint' })}>
          <ClassificationEditor request={r} />
          <div className="mt-1">
            <EditableAmount
              request={r}
              field="user_complaint_amount"
              label={t('compensation.claimed', { defaultValue: 'Claimed amount (SAR)' })}
              hint={t('compensation.claimedHint', {
                defaultValue: 'Used by PERCENT-type compensation rules.',
              })}
            />
          </div>
          {r.description && (
            <p className="mt-2 whitespace-pre-wrap text-xs text-foreground/90">{r.description}</p>
          )}
        </Section>
        <Section title={t('compensation.resolution', { defaultValue: 'Compensation' })}>
          <Row
            label={t('compensation.suggested', { defaultValue: 'Suggested' })}
            value={r.suggested_compensation_value ?? '—'}
          />
          <Row
            label={t('compensation.final', { defaultValue: 'Final value' })}
            value={money(r.final_compensation_value)}
          />
          <Row
            label={t('compensation.coupon', { defaultValue: 'Coupon' })}
            value={r.coupons?.Code ?? r.coupon_code ?? '—'}
          />
          {r.decline_reason && (
            <Row
              label={t('compensation.declineReason', { defaultValue: 'Decline reason' })}
              value={r.decline_reason}
            />
          )}
        </Section>
      </div>

      <ItemsEditor request={r} />

      {items && items.length > 0 && (
        <Section title={t('compensation.orderItems', { defaultValue: 'Order line items' })}>
          <ul className="space-y-1 text-xs">
            {items.map((it) => (
              <li key={it.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate">
                  <span className="tabular-nums text-foreground/80">{it.quantity ?? 1}×</span>{' '}
                  {it.name}
                </span>
                <span className="shrink-0 tabular-nums">{money(it.price)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/* ── Classification editor (the request's "related data") ────────────── */

/**
 * Lets ops set the request's Category + Issue from the portal — the related data
 * the workflow buttons read: the Issue (com_issue) drives the SLA timers
 * (Acknowledge/Approve) and the compensation rules (Calculate). Ops have no
 * Directus access, so this is the only place they can classify a request. The
 * Agent policy permits updating only these two fields; auto-saves on change.
 */
function ClassificationEditor({ request }: { request: CompensationRow }) {
  const { t } = useTranslation();
  const { data: categories } = useComplaintCategories();
  const { data: issues } = useComIssues();
  const update = useUpdateRequest();
  const [catId, setCatId] = useState<string>(request.complaint_type?.id ?? '');
  const [issueId, setIssueId] = useState<string>(request.com_issue?.id ?? '');

  // Only offer Issues that belong to the chosen Category (all if none chosen).
  const issueOptions = useMemo(
    () =>
      (issues ?? []).filter((i) => !catId || String(i.com_issue_category ?? '') === String(catId)),
    [issues, catId],
  );

  const save = (patch: { com_issue?: string | null; complaint_type?: string | null }) =>
    update.mutate(
      { requestId: request.id, patch },
      {
        onError: () =>
          toast.error(
            t('compensation.classifyError', { defaultValue: 'Could not save. Try again.' }),
          ),
      },
    );

  const onCategory = (v: string) => {
    setCatId(v);
    // Drop the Issue if it no longer belongs to the newly chosen Category.
    const keep = (issues ?? []).some(
      (i) => i.id === issueId && String(i.com_issue_category ?? '') === String(v),
    );
    if (!keep) setIssueId('');
    save({ complaint_type: v || null, ...(keep ? {} : { com_issue: null }) });
  };
  const onIssue = (v: string) => {
    setIssueId(v);
    save({ com_issue: v || null });
  };

  return (
    <div className="mb-1 space-y-2">
      <FormField label={t('compensation.type', { defaultValue: 'Category' })}>
        <Select value={catId} onChange={(e) => onCategory(e.currentTarget.value)}>
          <option value="">
            {t('compensation.unclassified', { defaultValue: 'Unclassified' })}
          </option>
          {(categories ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.id}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label={t('compensation.issue', { defaultValue: 'Issue' })}
        hint={t('compensation.issueHint', {
          defaultValue: 'Drives the SLA timers and the compensation calculation.',
        })}
      >
        <Select value={issueId} onChange={(e) => onIssue(e.currentTarget.value)}>
          <option value="">
            {t('compensation.selectIssue', { defaultValue: 'Select an issue…' })}
          </option>
          {issueOptions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name ?? i.id}
            </option>
          ))}
        </Select>
      </FormField>
    </div>
  );
}

/* ── Order / amounts + items editors (data the calc rules read) ──────── */

type AmountField = 'order_total' | 'delivery_fee' | 'user_complaint_amount';

/**
 * An inline-editable currency amount that the compensation rules read
 * (DELIVERY → delivery_fee, PERCENT → user_complaint_amount, …). Saves on blur,
 * only when changed. Agent policy permits these fields; other writes go via flows.
 */
function EditableAmount({
  request,
  field,
  label,
  hint,
}: {
  request: CompensationRow;
  field: AmountField;
  label: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const update = useUpdateRequest();
  const [val, setVal] = useState<string>(request[field] == null ? '' : String(request[field]));

  const save = () => {
    const trimmed = val.trim();
    const num = trimmed === '' ? null : Number(trimmed);
    if (num !== null && Number.isNaN(num)) return;
    if ((num ?? null) === (request[field] ?? null)) return; // unchanged
    update.mutate(
      { requestId: request.id, patch: { [field]: num } as RequestPatch },
      {
        onError: () =>
          toast.error(t('compensation.saveError', { defaultValue: 'Could not save. Try again.' })),
      },
    );
  };

  return (
    <FormField label={label} hint={hint}>
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={val}
        onChange={(e) => setVal(e.currentTarget.value)}
        onBlur={save}
      />
    </FormField>
  );
}

/**
 * Editor for `items_with_issue` — the JSON list an ITEMS-rule calculation sums
 * (Σ price). Ops add/remove rows and edit name/price/quantity; the whole array
 * is saved on blur / add / remove.
 */
function ItemsEditor({ request }: { request: CompensationRow }) {
  const { t } = useTranslation();
  const update = useUpdateRequest();
  const [items, setItems] = useState<IssueItem[]>(() => request.items_with_issue ?? []);

  const persist = (next: IssueItem[]) => {
    setItems(next);
    update.mutate(
      { requestId: request.id, patch: { items_with_issue: next } },
      {
        onError: () =>
          toast.error(t('compensation.saveError', { defaultValue: 'Could not save. Try again.' })),
      },
    );
  };
  const edit = (i: number, key: keyof IssueItem, raw: string) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? { ...it, [key]: key === 'name' ? raw : raw.trim() === '' ? null : Number(raw) }
          : it,
      ),
    );
  const total = items.reduce((s, it) => s + (Number(it.price) || 0), 0);

  return (
    <Section title={t('compensation.itemsWithIssue', { defaultValue: 'Items with issue' })}>
      <p className="mb-2 text-2xs text-muted-foreground">
        {t('compensation.itemsWithIssueHint', {
          defaultValue: 'Used by ITEMS-type compensation rules (sums the prices below).',
        })}
      </p>
      {items.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <Input
                className="flex-1"
                placeholder={t('compensation.itemName', { defaultValue: 'Item' })}
                value={it.name ?? ''}
                onChange={(e) => edit(i, 'name', e.currentTarget.value)}
                onBlur={() => persist(items)}
              />
              <Input
                className="w-16"
                type="number"
                inputMode="numeric"
                placeholder="Qty"
                value={it.quantity ?? ''}
                onChange={(e) => edit(i, 'quantity', e.currentTarget.value)}
                onBlur={() => persist(items)}
              />
              <Input
                className="w-24"
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder={t('compensation.price', { defaultValue: 'Price' })}
                value={it.price ?? ''}
                onChange={(e) => edit(i, 'price', e.currentTarget.value)}
                onBlur={() => persist(items)}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('compensation.removeItem', { defaultValue: 'Remove item' })}
                onClick={() => persist(items.filter((_, idx) => idx !== i))}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => persist([...items, { name: '', quantity: 1, price: null }])}
        >
          + {t('compensation.addItem', { defaultValue: 'Add item' })}
        </Button>
        {items.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('compensation.itemsTotal', { defaultValue: 'Total' })}: {money(total)}
          </span>
        )}
      </div>
    </Section>
  );
}

/* ── Action panel ────────────────────────────────────────────────── */

function ActionPanel({ request }: { request: CompensationRow }) {
  const { t } = useTranslation();
  const trigger = useTriggerCompensationFlow();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // The action whose input form is open (null = none). Only actions with
  // `inputs` open a form; the rest fire on click.
  const [formKey, setFormKey] = useState<string | null>(null);

  // Fire this record's Directus flow. Actions with no manual inputs are
  // one-click; actions with inputs pass the operator's values as the flow
  // trigger body (the SAME fields prod's manual-trigger dialog asks for), so
  // Directus still owns all the logic — the portal only collects + forwards.
  const run = (a: CompAction, inputs?: Record<string, unknown>) => {
    setPendingKey(a.key);
    trigger.mutate(
      { flowId: a.flowId, requestId: request.id, inputs },
      {
        onSuccess: () => {
          setFormKey(null);
          toast.success(
            t('compensation.done', { label: a.label, defaultValue: '{{label}} done.' }),
          );
        },
        onError: () =>
          toast.error(t('compensation.actionError', { defaultValue: 'Action failed. Try again.' })),
        onSettled: () => setPendingKey(null),
      },
    );
  };

  const onClick = (a: CompAction) => {
    if (a.inputs.length === 0) {
      run(a);
      return;
    }
    // Toggle the form for this action (close it if it's already open).
    setFormKey((k) => (k === a.key ? null : a.key));
  };

  const openAction = COMPENSATION_ACTIONS.find((a) => a.key === formKey) ?? null;

  return (
    <div className="rounded-2xl bg-card p-4 shadow-soft">
      <h3 className="mb-3 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('compensation.actions', { defaultValue: 'Actions' })}
      </h3>
      <div className="flex flex-wrap gap-2">
        {COMPENSATION_ACTIONS.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant={BTN_VARIANT[a.type]}
            onClick={() => onClick(a)}
            loading={pendingKey === a.key}
            disabled={trigger.isPending && pendingKey !== a.key}
            aria-expanded={a.inputs.length > 0 ? formKey === a.key : undefined}
          >
            {a.label}
          </Button>
        ))}
      </div>

      {openAction && (
        <ActionForm
          key={openAction.key}
          action={openAction}
          pending={pendingKey === openAction.key}
          onCancel={() => setFormKey(null)}
          onSubmit={(inputs) => run(openAction, inputs)}
        />
      )}
    </div>
  );
}

/**
 * The input form for an action whose prod flow requires manual fields. Renders
 * one control per `action.inputs` entry, enforces `required`, and hands the
 * collected values back so they ride along with the flow trigger.
 */
function ActionForm({
  action,
  pending,
  onCancel,
  onSubmit,
}: {
  action: CompAction;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (inputs: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const set = (field: string, v: string) => {
    setValues((prev) => ({ ...prev, [field]: v }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: false }));
  };

  const submit = () => {
    const nextErrors: Record<string, boolean> = {};
    for (const inp of action.inputs) {
      if (inp.required && !(values[inp.field] ?? '').trim()) nextErrors[inp.field] = true;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    // Only forward fields the operator actually filled — matches Directus'
    // manual trigger, which omits untouched optional inputs.
    const inputs: Record<string, unknown> = {};
    for (const inp of action.inputs) {
      const v = (values[inp.field] ?? '').trim();
      if (v) inputs[inp.field] = v;
    }
    onSubmit(inputs);
  };

  return (
    <form
      className="mt-4 space-y-3 rounded-xl bg-secondary/30 p-4 ring-1 ring-foreground/[0.04]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-xs font-medium text-foreground">
        {t('compensation.formTitle', {
          label: action.label,
          defaultValue: '{{label}} — fill the required fields',
        })}
      </p>
      {action.inputs.map((inp) => (
        <ActionInput
          key={inp.field}
          input={inp}
          value={values[inp.field] ?? ''}
          invalid={errors[inp.field] ?? false}
          onChange={(v) => set(inp.field, v)}
        />
      ))}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" variant={BTN_VARIANT[action.type]} loading={pending}>
          {t('compensation.submit', { label: action.label, defaultValue: 'Confirm {{label}}' })}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          {t('compensation.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </form>
  );
}

function ActionInput({
  input,
  value,
  invalid,
  onChange,
}: {
  input: CompInput;
  value: string;
  invalid: boolean;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const label = (
    <>
      {input.label}
      {input.required && <span className="text-destructive"> *</span>}
    </>
  );
  const error = invalid
    ? t('compensation.required', { defaultValue: 'This field is required.' })
    : undefined;

  return (
    <FormField label={label} error={error}>
      {input.kind === 'text' ? (
        <Textarea
          value={value}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      ) : input.kind === 'select' ? (
        <Select value={value} invalid={invalid} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">
            {t('compensation.selectPlaceholder', { defaultValue: 'Select…' })}
          </option>
          {(input.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.text}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          type={input.kind === 'dateTime' ? 'datetime-local' : 'text'}
          value={value}
          invalid={invalid}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

/* ── Route entry ─────────────────────────────────────────────────── */

export function CompensationPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <RequestDetail id={id} /> : <RequestQueue />;
}
