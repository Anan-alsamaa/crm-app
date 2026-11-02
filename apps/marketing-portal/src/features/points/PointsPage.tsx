import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizePhone } from '@yiji/shared-types';
import { Button, EmptyState, Input, Spinner, cn } from '@yiji/ui';
import { PageHeader, PAGE_BODY, SECTION_CARD } from '../../components/shell/Page.js';
import {
  PointsError,
  asList,
  useCustomerPoints,
  usePointsReport,
  usePointsRules,
  type PointsEntry,
  type PointsRule,
} from './api.js';

type Tab = 'customer' | 'rules' | 'reports';

const day = (s?: string | null) => (s ? String(s).slice(0, 10) : '—');

function ErrorNote({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const code = error instanceof PointsError ? error.code : '';
  const text =
    code === 'not_allowed'
      ? t('points.notAllowed', { defaultValue: 'Your role cannot look at points.' })
      : code === 'yiji_refused'
        ? t('points.refused', {
            defaultValue: "Yiji does not allow the CRM's account to read this.",
          })
        : code === 'bad_request'
          ? t('points.badRequest', { defaultValue: 'Check the dates: at most 31 days.' })
          : t('points.unavailable', {
              defaultValue: 'Yiji did not answer. Try again in a minute.',
            });
  return <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{text}</p>;
}

/**
 * POINTS (owner, 2026-11-02). Read-only for now: a customer's points, how
 * points are earned, and Yiji's issued/used reports. Giving points and changing
 * the rules arrive next, behind a manager's approval like coupons.
 */
export function PointsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('customer');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'customer', label: t('points.tabCustomer', { defaultValue: 'Customer points' }) },
    { id: 'rules', label: t('points.tabRules', { defaultValue: 'How points are earned' }) },
    { id: 'reports', label: t('points.tabReports', { defaultValue: 'Reports' }) },
  ];
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('points.title', { defaultValue: 'Points' })}
        description={t('points.desc', {
          defaultValue:
            "Customers' loyalty points on Yiji. Looking is open now; giving points and changing the rules will need a manager's approval.",
        })}
      />
      <div className={PAGE_BODY}>
        <div role="tablist" className="mb-4 flex flex-wrap gap-2">
          {tabs.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
                tab === x.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
        {tab === 'customer' && <CustomerTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'reports' && <ReportsTab />}
      </div>
    </div>
  );
}

function CustomerTab() {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const q = useCustomerPoints(phone);
  const entries = asList<PointsEntry>(q.data?.points);
  const total = entries.reduce((s, e) => s + (Number(e.points) || 0), 0);
  return (
    <div className="space-y-4">
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const p = normalizePhone(typed);
          if (/^05\d{8}$/.test(p)) setPhone(p);
        }}
      >
        <Input
          value={typed}
          inputMode="tel"
          placeholder={t('points.phonePh', { defaultValue: 'Customer phone, e.g. 05XXXXXXXX' })}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" variant="brand">
          {t('points.find', { defaultValue: 'Find' })}
        </Button>
      </form>
      {q.isFetching ? (
        <Spinner size={20} />
      ) : q.isError ? (
        <ErrorNote error={q.error} />
      ) : q.data && !q.data.found ? (
        <EmptyState
          title={
            q.data.reason === 'several'
              ? t('points.several', { defaultValue: 'More than one Yiji account has this number' })
              : t('points.none', { defaultValue: 'No Yiji account has this number' })
          }
        />
      ) : q.data?.found ? (
        <div className={cn(SECTION_CARD, 'p-5')}>
          <div className="flex flex-wrap items-baseline gap-x-4">
            <h2 className="text-md font-semibold">
              {q.data.customer?.name || q.data.customer?.phone}
            </h2>
            <span className="text-sm text-muted-foreground">{q.data.customer?.phone}</span>
            <span className="ms-auto text-sm">
              {t('points.listed', { defaultValue: 'Points listed' })}:{' '}
              <b className="tabular-nums">{total.toLocaleString()}</b>
            </span>
          </div>
          {entries.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {t('points.noEntries', { defaultValue: 'No points on this account.' })}
            </p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-2 text-start font-medium">
                    {t('points.colPoints', { defaultValue: 'Points' })}
                  </th>
                  <th className="py-2 text-start font-medium">
                    {t('points.colOrder', { defaultValue: 'From order' })}
                  </th>
                  <th className="py-2 text-start font-medium">
                    {t('points.colGiven', { defaultValue: 'Given' })}
                  </th>
                  <th className="py-2 text-start font-medium">
                    {t('points.colExpires', { defaultValue: 'Expires' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id ?? i} className="border-t border-foreground/[0.06] tabular-nums">
                    <td className="py-2">{e.points ?? '—'}</td>
                    <td className="py-2">{e.earnByOrderId || '—'}</td>
                    <td className="py-2">{day(e.creationTime)}</td>
                    <td className="py-2">{day(e.expirationDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RulesTab() {
  const { t } = useTranslation();
  const q = usePointsRules();
  if (q.isLoading) return <Spinner size={20} />;
  if (q.isError) return <ErrorNote error={q.error} />;
  const fixed = asList<PointsRule>(q.data?.fixed);
  const pct = asList<PointsRule>(q.data?.percentage);
  const block = (
    title: string,
    rows: PointsRule[],
    cols: [string, (r: PointsRule) => string][],
  ) => (
    <div className={cn(SECTION_CARD, 'p-5')}>
      <h2 className="text-md font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('points.noRules', { defaultValue: 'None set.' })}
        </p>
      ) : (
        <table className="mt-3 w-full text-sm tabular-nums">
          <thead>
            <tr className="text-xs text-muted-foreground">
              {cols.map(([h]) => (
                <th key={h} className="py-2 text-start font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-foreground/[0.06]">
                {cols.map(([h, fn]) => (
                  <td key={h} className="py-2">
                    {fn(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
  const active = (r: PointsRule) =>
    r.status === 0
      ? t('points.active', { defaultValue: 'Active' })
      : t('points.inactive', { defaultValue: 'Off' });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {block(t('points.fixed', { defaultValue: 'Fixed points' }), fixed, [
        ['#', (r) => String(r.id)],
        [t('points.colPoints', { defaultValue: 'Points' }), (r) => String(r.fixedPoints ?? '—')],
        [t('points.colStatus', { defaultValue: 'Status' }), active],
      ])}
      {block(t('points.percentage', { defaultValue: 'Points as a % of the order' }), pct, [
        ['#', (r) => String(r.id)],
        ['%', (r) => String(r.pourcentagePoints ?? '—')],
        [
          t('points.unit', { defaultValue: 'SAR per point' }),
          (r) => String(r.unitPointEquivalent ?? '—'),
        ],
        [t('points.colStatus', { defaultValue: 'Status' }), active],
      ])}
    </div>
  );
}

function ReportsTab() {
  const { t } = useTranslation();
  const first = new Date();
  first.setDate(1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [type, setType] = useState<'issued' | 'consumed'>('issued');
  const [from, setFrom] = useState(iso(first));
  const [to, setTo] = useState(iso(new Date()));
  const [asked, setAsked] = useState<{
    type: 'issued' | 'consumed';
    from: string;
    to: string;
  } | null>(null);
  const q = usePointsReport(asked);
  const rows = asList<Record<string, unknown>>(q.data);
  const cols = useMemo(() => (rows[0] ? Object.keys(rows[0]).slice(0, 10) : []), [rows]);
  const csv = () => {
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join(
      '\n',
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
    a.download = `points-${asked?.type}-${asked?.from}-${asked?.to}.csv`;
    a.click();
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <select
          className="h-9 rounded-lg border bg-background px-2 text-sm"
          value={type}
          onChange={(e) => setType(e.target.value as 'issued' | 'consumed')}
        >
          <option value="issued">{t('points.issued', { defaultValue: 'Points issued' })}</option>
          <option value="consumed">{t('points.consumed', { defaultValue: 'Points used' })}</option>
        </select>
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-40"
        />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        <Button
          variant="brand"
          onClick={() => setAsked({ type, from: `${from} 07:00`, to: `${to} 07:00` })}
        >
          {t('points.show', { defaultValue: 'Show' })}
        </Button>
        {rows.length > 0 && (
          <Button variant="outline" onClick={csv}>
            {t('points.csv', { defaultValue: 'Download CSV' })}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('points.window', {
          defaultValue: 'Each day runs 07:00 to 07:00. At most 31 days at a time.',
        })}
      </p>
      {q.isFetching ? (
        <Spinner size={20} />
      ) : q.isError ? (
        <ErrorNote error={q.error} />
      ) : asked && rows.length === 0 ? (
        <EmptyState title={t('points.empty', { defaultValue: 'Nothing in this period' })} />
      ) : rows.length > 0 ? (
        <div className={cn(SECTION_CARD, 'overflow-x-auto p-4')}>
          <p className="mb-2 text-sm">
            {t('points.rows', { defaultValue: '{{n}} rows', n: rows.length.toLocaleString() })}
            {rows.length > 200 &&
              ` - ${t('points.first200', { defaultValue: 'first 200 shown; the CSV has all' })}`}
          </p>
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-muted-foreground">
                {cols.map((c) => (
                  <th key={c} className="whitespace-nowrap py-2 pe-3 text-start font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => (
                <tr key={i} className="border-t border-foreground/[0.06]">
                  {cols.map((c) => (
                    <td key={c} className="whitespace-nowrap py-1.5 pe-3">
                      {r[c] == null ? '' : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
