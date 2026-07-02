import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  Button,
  cn,
  EmptyState,
  Input,
  Pill,
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
import { actionsForStatus, type CompAction } from './actions.js';

const STATUS_TONE: Record<CompensationStatus, 'warning' | 'primary' | 'success' | 'destructive'> = {
  Pending: 'warning',
  'In Progress': 'primary',
  Approved: 'success',
  Rejected: 'destructive',
};

const BTN_VARIANT: Record<CompAction['tone'], 'default' | 'brand' | 'secondary' | 'destructive'> = {
  primary: 'default',
  success: 'brand',
  destructive: 'destructive',
  neutral: 'secondary',
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
          <ArrowLeftIcon size={16} /> {t('compensation.back', { defaultValue: 'Back' })}
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
          <ArrowLeftIcon size={16} /> {t('compensation.back', { defaultValue: 'Back' })}
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
  const [active, setActive] = useState<CompAction | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const actions = actionsForStatus(request.status);
  if (actions.length === 0) {
    return (
      <div className="rounded-2xl bg-secondary/40 px-5 py-3 text-xs text-muted-foreground">
        {t('compensation.terminal', {
          defaultValue: 'This request is closed — no further actions.',
        })}
      </div>
    );
  }

  const open = (a: CompAction) => {
    setActive(a);
    setForm({});
    setErr(null);
  };

  const submit = () => {
    if (!active) return;
    const inputs: Record<string, unknown> = {};
    for (const inp of active.inputs) {
      const raw = (form[inp.field] ?? '').trim();
      if (inp.required && !raw) {
        setErr(t('compensation.required', { defaultValue: `${inp.label} is required.` }));
        return;
      }
      if (!raw) continue;
      if (inp.type === 'json') {
        try {
          inputs[inp.field] = JSON.parse(raw);
        } catch {
          setErr(t('compensation.badJson', { defaultValue: `${inp.label} must be valid JSON.` }));
          return;
        }
      } else {
        inputs[inp.field] = raw;
      }
    }
    trigger.mutate(
      { flowId: active.flowId, requestId: request.id, inputs },
      {
        onSuccess: () => {
          toast.success(t('compensation.done', { defaultValue: `${active.label} done.` }));
          setActive(null);
        },
        onError: () =>
          toast.error(t('compensation.actionError', { defaultValue: 'Action failed. Try again.' })),
      },
    );
  };

  return (
    <div className="rounded-2xl bg-card/70 px-5 py-4 ring-1 ring-foreground/[0.04] shadow-sm shadow-foreground/[0.04]">
      <h3 className="mb-3 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t('compensation.actions', { defaultValue: 'Actions' })}
      </h3>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant={BTN_VARIANT[a.tone]}
            onClick={() => open(a)}
            disabled={trigger.isPending}
          >
            {a.label}
          </Button>
        ))}
      </div>

      {active && (
        <div className="mt-4 space-y-3 rounded-xl bg-secondary/40 px-4 py-3">
          <div className="text-sm font-medium text-foreground">{active.label}</div>
          {active.inputs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {active.confirm ??
                t('compensation.confirm', { defaultValue: 'Confirm this action?' })}
            </p>
          ) : (
            <div className="space-y-2.5">
              {active.inputs.map((inp) => (
                <label key={inp.field} className="block">
                  <span className="mb-1 block text-2xs text-muted-foreground">
                    {inp.label}
                    {inp.required ? ' *' : ''}
                  </span>
                  {inp.type === 'text' || inp.type === 'json' ? (
                    <Textarea
                      value={form[inp.field] ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, [inp.field]: e.target.value }))}
                      rows={inp.type === 'json' ? 3 : 2}
                      placeholder={inp.type === 'json' ? '{ }' : ''}
                      aria-label={inp.label}
                    />
                  ) : (
                    <Input
                      type={inp.type === 'dateTime' ? 'datetime-local' : 'text'}
                      value={form[inp.field] ?? ''}
                      onChange={(e) => setForm((f) => ({ ...f, [inp.field]: e.target.value }))}
                      aria-label={inp.label}
                    />
                  )}
                </label>
              ))}
            </div>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} loading={trigger.isPending}>
              {t('compensation.run', { defaultValue: 'Confirm' })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setActive(null)}
              disabled={trigger.isPending}
            >
              {t('actions.cancel', { ns: 'common', defaultValue: 'Cancel' })}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Route entry ─────────────────────────────────────────────────── */

export function CompensationPage() {
  const { id } = useParams<{ id: string }>();
  return id ? <RequestDetail id={id} /> : <RequestQueue />;
}
