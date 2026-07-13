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
  COMPENSATION_STATUSES,
  type CompensationRow,
  type CompensationStatus,
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
  Acknowledged: 'neutral',
  'Calculating Compensation': 'primary',
  'Generating Coupon': 'primary',
  'Assign Coupon to User': 'primary',
  Accepted: 'success',
  Closed: 'muted',
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
      className="flex w-full items-center gap-4 rounded-2xl bg-card/70 px-4 py-3 text-start ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04] transition-colors duration-fast hover:bg-secondary/40"
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
    <div className="rounded-2xl bg-card/70 px-5 py-4 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04]">
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
          <Row
            label={t('compensation.orderTotal', { defaultValue: 'Order total' })}
            value={money(r.order_total)}
          />
          <Row
            label={t('compensation.deliveryFee', { defaultValue: 'Delivery fee' })}
            value={money(r.delivery_fee)}
          />
        </Section>
        <Section title={t('compensation.complaint', { defaultValue: 'Complaint' })}>
          <Row
            label={t('compensation.type', { defaultValue: 'Type' })}
            value={r.complaint_type?.name ?? '—'}
          />
          <Row
            label={t('compensation.issue', { defaultValue: 'Issue' })}
            value={r.com_issue?.name ?? '—'}
          />
          <Row
            label={t('compensation.claimed', { defaultValue: 'Claimed amount' })}
            value={money(r.user_complaint_amount)}
          />
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

      {items && items.length > 0 && (
        <Section title={t('compensation.items', { defaultValue: 'Items with issue' })}>
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
    <div className="rounded-2xl bg-card/70 px-5 py-4 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04]">
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
