import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cn,
  CheckCircleIcon,
  DateField,
  EmptyState,
  ErrorState,
  HBarChart,
  InboxIcon,
  Pill,
  ReportKpi,
  ReportKpiStrip,
  SelectMenu,
  Skeleton,
  SplitBar,
  Table,
  TablePager,
  TableFooterBar,
  TableSurface,
  Td,
  Th,
  TicketIcon,
  Tr,
  TrendChart,
  ZapIcon,
  formatDate,
  formatDateTime,
  type ChartTone,
} from '@yiji/ui';
import { downloadCsv, formatDuration, toCsv } from '@yiji/reports';
import { exportFileName } from '@yiji/shared-config';
import { businessDayWindow, defaultReportRange, useRememberedRange } from '../../lib/date-range.js';
import {
  useAiKpi,
  useChatsKpi,
  useCouponsKpi,
  useLateOrdersKpi,
  useNotificationsKpi,
  usePeopleKpi,
  useTicketsKpi,
  useYijiUsageKpi,
  RECENT_USAGE_LIMIT,
  type YijiUsageEventRow,
} from './api.js';
import { FIELD_LABEL, PAGE_GUTTER, PageTitle } from '../../components/shell/Page.js';
import { ExportCsvButton } from '../../components/ExportCsvButton.js';
import { ClearFiltersButton } from '../../components/ClearFiltersButton.js';
import { SearchField } from '../../components/SearchField.js';
import { RangePreset } from '../../components/RangePreset.js';

/**
 * REPORTS -> ADMIN KPI (owner, 2026-10-21; laid out again 2026-10-22).
 *
 * Every feature's figures for the chosen window, read-only, for the owner:
 * chats, tickets, coupons, late orders, people, notifications, AI - and the
 * CRM's calls to Yiji, split by WHICH ACCOUNT made them (the CRM's own, or
 * the owner's backup token), with every backup use and every failure listed.
 *
 * THE LAYOUT READS TOP-DOWN BY WEIGHT (owner, 2026-10-22: "arrange and
 * position the cards in a better way"). It was 28 identical tiles in a
 * masonry, so the headline numbers and the footnotes looked the same size,
 * and the Yiji search sat in the page's filter card although it only ever
 * filtered the Yiji table. Now:
 *
 *   1. the window (dates + quick range) beside the title - it governs all;
 *   2. four headline tiles - chats, tickets, coupons approved, Yiji calls;
 *   3. one card per domain, its numbers as a compact list and, where a
 *      proportion is the point, one bar (closed vs open, the coupon funnel);
 *   4. the Yiji section, full width, with ITS OWN search, account filter and
 *      export, the account split, the trend, the operations and the table.
 *
 * Data, queries and gating are unchanged. Each block still loads and fails on
 * its own, so one unreadable collection costs one card.
 */

const NUM = new Intl.NumberFormat('en-US');
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const n = (v: number) => NUM.format(v);
const PAGE_SIZES = [10, 25, 50, 100] as const;

/** A block that may fail alone: its own error, its own retry. */
function Block({
  error,
  onRetry,
  className,
  children,
}: {
  error: boolean;
  onRetry: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!error) return <>{children}</>;
  return (
    <div className={cn('rounded-2xl bg-card shadow-soft ring-1 ring-foreground/[0.06]', className)}>
      <ErrorState
        className="py-8"
        title={t('adminKpi.blockError', { defaultValue: 'This block could not be loaded.' })}
        retryLabel={t('adminKpi.retry', { defaultValue: 'Retry' })}
        onRetry={onRetry}
      />
    </div>
  );
}

/** One figure in a domain card's list. `value: null` is "no data" (a muted dash). */
interface Stat {
  label: string;
  value: string | null;
  /** A figure whose colour is the message (failures). */
  tone?: 'bad';
}

/**
 * One domain, one card: title and what it counts, an optional bar for the
 * proportion that matters, then the numbers as a label | value list. With
 * nothing in the window it says so in one line instead of a column of zeros.
 */
function DomainCard({
  id,
  title,
  note,
  loading,
  empty,
  visual,
  stats,
  columns = 1,
  className,
}: {
  id: string;
  title: string;
  note: string;
  loading: boolean;
  empty: boolean;
  visual?: ReactNode;
  stats: Stat[];
  /** The coupon card is twice as wide on a desktop and lists in two columns. */
  columns?: 1 | 2;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby={id}
      data-section-card=""
      className={cn(
        'flex flex-col gap-4 rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]',
        /* An empty domain keeps its own short height instead of stretching
           to its row: a tall card saying "nothing" reads as broken. */
        empty && !loading && 'self-start',
        className,
      )}
    >
      <header>
        <h2 id={id} className="text-[1.0625rem] font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      </header>
      {loading ? (
        <div className="space-y-2.5">
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : empty ? (
        <p className="text-sm text-muted-foreground">
          {t('adminKpi.emptySection', { defaultValue: 'Nothing in this window.' })}
        </p>
      ) : (
        <>
          {visual}
          <dl
            className={cn(
              'grid gap-x-8 text-sm',
              columns === 2 && 'sm:grid-cols-2',
              /* Hairlines between rows, not around them: a list, not a table. */
              '[&>div]:border-t [&>div]:border-foreground/[0.06]',
            )}
          >
            {stats.map((s) => (
              <div key={s.label} className="flex items-baseline justify-between gap-4 py-2">
                <dt className="min-w-0 text-muted-foreground">{s.label}</dt>
                <dd
                  className={cn(
                    'shrink-0 font-semibold tabular-nums',
                    s.value === null
                      ? 'text-muted-foreground/70'
                      : s.tone === 'bad' && s.value !== '0'
                        ? 'text-destructive'
                        : 'text-foreground',
                  )}
                >
                  {s.value ?? '—'}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

/**
 * Requested -> approved -> pushed to Yiji, each a bar against what was asked
 * for. The coupon card's one picture: where requests fall out of the line.
 */
function Funnel({
  steps,
  label,
}: {
  steps: ReadonlyArray<{ label: string; value: number; tone: 'primary' | 'success' | 'sky' }>;
  label: string;
}) {
  const top = Math.max(1, steps[0]?.value ?? 0);
  const fill = { primary: 'bg-primary', success: 'bg-success', sky: 'bg-sky' } as const;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <ol className="space-y-1.5">
        {steps.map((s) => (
          <li
            key={s.label}
            className="grid grid-cols-[7.5rem_minmax(0,1fr)_3rem] items-center gap-3 text-xs"
          >
            <span className="truncate text-muted-foreground">{s.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-secondary">
              <span
                className={cn('block h-full rounded-full', fill[s.tone])}
                style={{ width: `${Math.min(100, (s.value / top) * 100)}%` }}
              />
            </span>
            <span className="text-end font-semibold tabular-nums text-foreground">
              {n(s.value)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A captioned SplitBar; renders nothing when every part is zero. */
function Split({
  caption,
  parts,
}: {
  caption?: string;
  parts: ReadonlyArray<{ label: string; value: number; tone: ChartTone }>;
}) {
  if (parts.every((p) => p.value === 0)) return null;
  return (
    <div>
      {caption && <p className="mb-2 text-xs font-medium text-muted-foreground">{caption}</p>}
      <SplitBar parts={parts} />
    </div>
  );
}

/** CRM vs backup as a ring, the CRM share in the middle. */
function AccountDonut({
  crm,
  backup,
  crmLabel,
  backupLabel,
  caption,
}: {
  crm: number;
  backup: number;
  crmLabel: string;
  backupLabel: string;
  caption: string;
}) {
  const total = crm + backup;
  const size = 132;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const crmPct = total ? (crm / total) * 100 : 0;
  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-label={caption}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            className={total ? 'stroke-warning' : 'stroke-secondary'}
          />
          {total > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              strokeDasharray={`${(crmPct / 100) * c} ${c}`}
              className="stroke-primary"
            />
          )}
        </svg>
        <span className="absolute inset-0 grid place-items-center text-center">
          <span>
            <span className="block text-[1.375rem] font-semibold leading-none tabular-nums text-foreground">
              {total ? `${Math.round(crmPct)}%` : '—'}
            </span>
            <span className="mt-1 block text-2xs text-muted-foreground">{crmLabel}</span>
          </span>
        </span>
      </div>
      <ul className="min-w-0 space-y-2 text-sm">
        <li className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />
          <span className="text-muted-foreground">{crmLabel}</span>
          <span className="ms-auto ps-3 font-semibold tabular-nums">{n(crm)}</span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-warning" />
          <span className="text-muted-foreground">{backupLabel}</span>
          <span className="ms-auto ps-3 font-semibold tabular-nums">{n(backup)}</span>
        </li>
      </ul>
    </div>
  );
}

const PANEL = 'rounded-2xl bg-secondary/40 p-4 ring-1 ring-inset ring-foreground/[0.05]';

export function AdminKpiPage() {
  const { t } = useTranslation();
  const range = useRememberedRange('admin-kpi-range', defaultReportRange);
  const { from, to, setFrom, setTo } = range;
  const w = useMemo(() => businessDayWindow(from, to), [from, to]);
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  const chats = useChatsKpi(w);
  const tickets = useTicketsKpi(w);
  const coupons = useCouponsKpi(w);
  const late = useLateOrdersKpi(w);
  const people = usePeopleKpi();
  const notes = useNotificationsKpi(w);
  const ai = useAiKpi(w);
  const yiji = useYijiUsageKpi(w);

  const recent = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (yiji.data?.recent ?? []).filter(
      (r) =>
        (!account || r.account === account) &&
        (!needle ||
          [r.operation, r.service, r.error ?? '', r.fallback_reason ?? '']
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
  }, [yiji.data, search, account]);
  const pageRows = recent.slice((page - 1) * pageSize, page * pageSize);

  const accountLabel = (a: string) =>
    a === 'backup'
      ? t('adminKpi.yiji.backup', { defaultValue: 'Backup token' })
      : t('adminKpi.yiji.crm', { defaultValue: 'CRM account' });
  const outcomeLabel = (o: string) =>
    o === 'ok'
      ? t('adminKpi.yiji.ok', { defaultValue: 'OK' })
      : o === 'refused'
        ? t('adminKpi.yiji.refused', { defaultValue: 'Refused' })
        : t('adminKpi.yiji.error', { defaultValue: 'Error' });

  const exportRecent = () =>
    downloadCsv(
      exportFileName('yiji-api-usage'),
      toCsv(
        ['When', 'Service', 'Operation', 'Account', 'Outcome', 'HTTP', 'ms', 'Why backup', 'Error'],
        recent.map((r: YijiUsageEventRow) => [
          r.date_created,
          r.service,
          r.operation,
          r.account,
          r.outcome,
          r.http_status ?? '',
          r.duration_ms ?? '',
          r.fallback_reason ?? '',
          r.error ?? '',
        ]),
      ),
    );

  const c = chats.data;
  const tk = tickets.data;
  const cp = coupons.data;
  const lo = late.data;
  const pp = people.data;
  const nt = notes.data;
  const aiS = ai.data;
  const y = yiji.data;

  const removalOf = (k: string) => cp?.removal[k] ?? 0;
  const removalTotal = Object.values(cp?.removal ?? {}).reduce((a, b) => a + b, 0);
  const failedCalls = (y?.totals.refused ?? 0) + (y?.totals.error ?? 0);
  /* A hero tile is "—" until its block answers, never a confident 0. */
  const hero = (ready: boolean, v: number) => (ready ? n(v) : '—');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className={cn('flex-1 overflow-auto', PAGE_GUTTER)}>
        <div className="space-y-5 pb-8">
          {/* ── 1. Title, and the window that governs every figure below ── */}
          <PageTitle
            title={t('nav.adminKpiGroup', { defaultValue: 'Admin KPI' })}
            description={t('adminKpi.description', {
              defaultValue: "Every feature's figures for the chosen window, at a glance.",
            })}
            actions={
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL}>
                    {t('complaintDash.from', { defaultValue: 'From' })}
                  </span>
                  <DateField className="w-[9.5rem]" value={from} onChange={setFrom} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL}>
                    {t('complaintDash.to', { defaultValue: 'To' })}
                  </span>
                  <DateField className="w-[9.5rem]" value={to} onChange={setTo} />
                </label>
                <div className="w-44">
                  <RangePreset range={range} />
                </div>
              </div>
            }
          />

          {/* ── 2. The four headline numbers ─────────────────────────────── */}
          <ReportKpiStrip>
            <ReportKpi
              tone="blue"
              icon={<InboxIcon size={18} />}
              label={t('adminKpi.chats.title', { defaultValue: 'Chats' })}
              value={hero(!!c, c?.total ?? 0)}
              hint={
                c
                  ? t('adminKpi.hero.chatsHint', {
                      defaultValue: '{{closed}} closed · {{open}} open',
                      closed: n(c.closed),
                      open: n(c.open),
                    })
                  : undefined
              }
            />
            <ReportKpi
              tone="violet"
              icon={<TicketIcon size={18} />}
              label={t('adminKpi.tickets.title', { defaultValue: 'Tickets' })}
              value={hero(!!tk, tk?.created ?? 0)}
              hint={
                tk
                  ? t('adminKpi.hero.ticketsHint', {
                      defaultValue: '{{num}} compensated',
                      num: n(tk.compensated),
                    })
                  : undefined
              }
            />
            <ReportKpi
              tone="green"
              icon={<CheckCircleIcon size={18} />}
              label={t('adminKpi.hero.couponsLabel', { defaultValue: 'Coupons approved' })}
              value={hero(!!cp, cp?.approved ?? 0)}
              hint={
                cp
                  ? t('adminKpi.hero.couponsHint', {
                      defaultValue: 'of {{num}} requested',
                      num: n(cp.requested),
                    })
                  : undefined
              }
            />
            <ReportKpi
              tone="amber"
              icon={<ZapIcon size={18} />}
              label={t('adminKpi.hero.yijiLabel', { defaultValue: 'Yiji calls' })}
              value={hero(!!y, y?.totals.total ?? 0)}
              hint={
                y
                  ? t('adminKpi.hero.yijiHint', {
                      defaultValue: '{{failed}} failed · {{backup}} via backup',
                      failed: n(failedCalls),
                      backup: n(y.totals.backup),
                    })
                  : undefined
              }
            />
          </ReportKpiStrip>

          {/* ── 3. One card per domain, the busiest first ────────────────
              Two columns from 1280px, three from 1536px. Coupons spans two
              (it has the most to say); AI spans two at three columns so the
              last row closes flush. Rows stretch, so cards in a row match. */}
          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            <Block
              error={coupons.isError}
              onRetry={() => void coupons.refetch()}
              className="xl:col-span-2"
            >
              <DomainCard
                id="admin-kpi-coupons"
                className="xl:col-span-2"
                columns={2}
                title={t('adminKpi.coupons.title', { defaultValue: 'Coupons' })}
                note={t('adminKpi.coupons.note', {
                  defaultValue: 'Requests raised in this window and what became of them.',
                })}
                loading={coupons.isLoading}
                empty={!!cp && cp.requested === 0 && removalTotal === 0}
                visual={
                  cp && (
                    <div className="grid gap-5 md:grid-cols-2">
                      <Funnel
                        label={t('adminKpi.coupons.funnel', {
                          defaultValue: 'From request to Yiji',
                        })}
                        steps={[
                          {
                            label: t('adminKpi.coupons.requested', { defaultValue: 'Requested' }),
                            value: cp.requested,
                            tone: 'primary',
                          },
                          {
                            label: t('adminKpi.coupons.approved', { defaultValue: 'Approved' }),
                            value: cp.approved,
                            tone: 'success',
                          },
                          {
                            label: t('adminKpi.coupons.pushed', { defaultValue: 'Pushed to Yiji' }),
                            value: cp.pushed,
                            tone: 'sky',
                          },
                        ]}
                      />
                      <div className="space-y-4">
                        <Split
                          caption={t('adminKpi.coupons.decisions', { defaultValue: 'Decisions' })}
                          parts={[
                            {
                              label: t('adminKpi.coupons.approved', { defaultValue: 'Approved' }),
                              value: cp.approved,
                              tone: 'success',
                            },
                            {
                              label: t('adminKpi.coupons.rejected', { defaultValue: 'Rejected' }),
                              value: cp.rejected,
                              tone: 'destructive',
                            },
                            {
                              label: t('adminKpi.coupons.pending', { defaultValue: 'Waiting' }),
                              value: cp.pending,
                              tone: 'warning',
                            },
                          ]}
                        />
                        <Split
                          caption={t('adminKpi.coupons.removals', { defaultValue: 'Removals' })}
                          parts={[
                            {
                              label: t('adminKpi.coupons.removed', { defaultValue: 'Removed' }),
                              value: removalOf('removed'),
                              tone: 'primary',
                            },
                            {
                              label: t('adminKpi.coupons.removalUsed', {
                                defaultValue: 'Already used',
                              }),
                              value: removalOf('used'),
                              tone: 'violet',
                            },
                            {
                              label: t('adminKpi.coupons.removalNotOnYiji', {
                                defaultValue: 'Not on Yiji',
                              }),
                              value: removalOf('not_on_yiji'),
                              tone: 'sky',
                            },
                            {
                              label: t('adminKpi.coupons.removalPending', {
                                defaultValue: 'Removal waiting',
                              }),
                              value: removalOf('pending'),
                              tone: 'warning',
                            },
                            {
                              label: t('adminKpi.coupons.removalFailed', {
                                defaultValue: 'Removal failed',
                              }),
                              value: removalOf('failed'),
                              tone: 'destructive',
                            },
                          ]}
                        />
                      </div>
                    </div>
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.coupons.requested', { defaultValue: 'Requested' }),
                    value: n(cp?.requested ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.approved', { defaultValue: 'Approved' }),
                    value: n(cp?.approved ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.rejected', { defaultValue: 'Rejected' }),
                    value: n(cp?.rejected ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.pending', { defaultValue: 'Waiting' }),
                    value: n(cp?.pending ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.pushed', { defaultValue: 'Pushed to Yiji' }),
                    value: n(cp?.pushed ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.pushFailures', { defaultValue: 'Push failures' }),
                    value: n(cp?.pushFailures ?? 0),
                    tone: 'bad',
                  },
                  {
                    label: t('adminKpi.coupons.withheld', { defaultValue: 'Withheld' }),
                    value: n(cp?.withheld ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.replaced', {
                      defaultValue: 'Edited after approval',
                    }),
                    value: n(cp?.replaced ?? 0),
                  },
                  {
                    label: t('adminKpi.coupons.removalFailed', { defaultValue: 'Removal failed' }),
                    value: n(removalOf('failed')),
                    tone: 'bad',
                  },
                ]}
              />
            </Block>

            <Block error={chats.isError} onRetry={() => void chats.refetch()}>
              <DomainCard
                id="admin-kpi-chats"
                title={t('adminKpi.chats.title', { defaultValue: 'Chats' })}
                note={t('adminKpi.chats.note', { defaultValue: 'Chats opened in this window.' })}
                loading={chats.isLoading}
                empty={!!c && c.total === 0}
                visual={
                  c && (
                    <Split
                      parts={[
                        {
                          label: t('adminKpi.chats.closed', { defaultValue: 'Closed' }),
                          value: c.closed,
                          tone: 'success',
                        },
                        {
                          label: t('adminKpi.chats.open', { defaultValue: 'Still open' }),
                          value: c.open,
                          tone: 'warning',
                        },
                      ]}
                    />
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.chats.total', { defaultValue: 'Chats' }),
                    value: n(c?.total ?? 0),
                  },
                  {
                    label: t('adminKpi.chats.closed', { defaultValue: 'Closed' }),
                    value: n(c?.closed ?? 0),
                  },
                  {
                    label: t('adminKpi.chats.open', { defaultValue: 'Still open' }),
                    value: n(c?.open ?? 0),
                  },
                  {
                    label: t('adminKpi.chats.avgFirst', { defaultValue: 'Avg first response' }),
                    value: formatDuration(c?.avgFirstResponseSec ?? null) ?? null,
                  },
                ]}
              />
            </Block>

            <Block error={tickets.isError} onRetry={() => void tickets.refetch()}>
              <DomainCard
                id="admin-kpi-tickets"
                title={t('adminKpi.tickets.title', { defaultValue: 'Tickets' })}
                note={t('adminKpi.tickets.note', {
                  defaultValue: 'Tickets created in this window, by compensation.',
                })}
                loading={tickets.isLoading}
                empty={!!tk && tk.created === 0}
                visual={
                  tk && (
                    <Split
                      parts={[
                        {
                          label: t('adminKpi.tickets.compensated', {
                            defaultValue: 'Compensated',
                          }),
                          value: tk.compensated,
                          tone: 'success',
                        },
                        {
                          label: t('adminKpi.tickets.notCompensated', {
                            defaultValue: 'Not compensated',
                          }),
                          value: tk.notCompensated,
                          tone: 'warning',
                        },
                        {
                          label: t('adminKpi.tickets.undecided', { defaultValue: 'Not decided' }),
                          value: tk.undecided,
                          tone: 'sky',
                        },
                      ]}
                    />
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.tickets.created', { defaultValue: 'Created' }),
                    value: n(tk?.created ?? 0),
                  },
                  {
                    label: t('adminKpi.tickets.compensated', { defaultValue: 'Compensated' }),
                    value: n(tk?.compensated ?? 0),
                  },
                  {
                    label: t('adminKpi.tickets.notCompensated', {
                      defaultValue: 'Not compensated',
                    }),
                    value: n(tk?.notCompensated ?? 0),
                  },
                  {
                    label: t('adminKpi.tickets.solved', { defaultValue: 'Solved' }),
                    value: n(tk?.byStatus.solved ?? 0),
                  },
                ]}
              />
            </Block>

            <Block error={late.isError} onRetry={() => void late.refetch()}>
              <DomainCard
                id="admin-kpi-late"
                title={t('adminKpi.late.title', { defaultValue: 'Late orders' })}
                note={t('adminKpi.late.note', {
                  defaultValue: 'Decisions in this window; each order counted by its newest one.',
                })}
                loading={late.isLoading}
                empty={!!lo && lo.decisions === 0}
                visual={
                  lo && (
                    <Split
                      parts={[
                        {
                          label: t('adminKpi.late.compensated', { defaultValue: 'Compensated' }),
                          value: lo.compensated,
                          tone: 'success',
                        },
                        {
                          label: t('adminKpi.late.commented', { defaultValue: 'Commented' }),
                          value: lo.commented,
                          tone: 'warning',
                        },
                      ]}
                    />
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.late.orders', { defaultValue: 'Orders decided' }),
                    value: n(lo?.orders ?? 0),
                  },
                  {
                    label: t('adminKpi.late.commented', { defaultValue: 'Commented' }),
                    value: n(lo?.commented ?? 0),
                  },
                  {
                    label: t('adminKpi.late.compensated', { defaultValue: 'Compensated' }),
                    value: n(lo?.compensated ?? 0),
                  },
                  {
                    label: t('adminKpi.late.decisions', { defaultValue: 'Decisions' }),
                    value: n(lo?.decisions ?? 0),
                  },
                ]}
              />
            </Block>

            <Block error={people.isError} onRetry={() => void people.refetch()}>
              <DomainCard
                id="admin-kpi-people"
                title={t('adminKpi.people.title', { defaultValue: 'Users & roles' })}
                note={t('adminKpi.people.note', {
                  defaultValue: 'Right now, not the window. Service accounts are left out.',
                })}
                loading={people.isLoading}
                empty={!!pp && pp.active + pp.suspended === 0}
                visual={
                  pp && (
                    <Split
                      parts={[
                        {
                          label: t('adminKpi.people.active', { defaultValue: 'Active users' }),
                          value: pp.active,
                          tone: 'success',
                        },
                        {
                          label: t('adminKpi.people.suspended', { defaultValue: 'Not active' }),
                          value: pp.suspended,
                          tone: 'sky',
                        },
                      ]}
                    />
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.people.active', { defaultValue: 'Active users' }),
                    value: n(pp?.active ?? 0),
                  },
                  {
                    label: t('adminKpi.people.suspended', { defaultValue: 'Not active' }),
                    value: n(pp?.suspended ?? 0),
                  },
                  {
                    label: t('adminKpi.people.roles', { defaultValue: 'Roles in use' }),
                    value: n(pp?.byRole.length ?? 0),
                  },
                  {
                    label: t('adminKpi.people.busyNow', { defaultValue: 'Busy right now' }),
                    value: n(pp?.busyNow ?? 0),
                  },
                ]}
              />
            </Block>

            <Block error={notes.isError} onRetry={() => void notes.refetch()}>
              <DomainCard
                id="admin-kpi-notifications"
                title={t('adminKpi.notifications.title', { defaultValue: 'Notifications' })}
                note={t('adminKpi.notifications.note', {
                  defaultValue: 'In-app notifications sent in this window.',
                })}
                loading={notes.isLoading}
                empty={!!nt && nt.total === 0}
                visual={
                  nt && (
                    <Split
                      parts={[
                        {
                          label: t('adminKpi.notifications.read', { defaultValue: 'Read' }),
                          value: Math.max(0, nt.total - nt.unread),
                          tone: 'success',
                        },
                        {
                          label: t('adminKpi.notifications.unread', {
                            defaultValue: 'Still unread',
                          }),
                          value: nt.unread,
                          tone: 'warning',
                        },
                      ]}
                    />
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.notifications.total', { defaultValue: 'Sent' }),
                    value: n(nt?.total ?? 0),
                  },
                  {
                    label: t('adminKpi.notifications.unread', { defaultValue: 'Still unread' }),
                    value: n(nt?.unread ?? 0),
                  },
                  ...(nt?.byType ?? [])
                    .slice(0, 2)
                    .map((x) => ({ label: x.type, value: n(x.count) })),
                ]}
              />
            </Block>

            <Block error={ai.isError} onRetry={() => void ai.refetch()} className="2xl:col-span-2">
              <DomainCard
                id="admin-kpi-ai"
                className="2xl:col-span-2"
                columns={2}
                title={t('adminKpi.ai.title', { defaultValue: 'AI calls' })}
                note={t('adminKpi.ai.note', {
                  defaultValue: 'Every model call; cost at the paid list price.',
                })}
                loading={ai.isLoading}
                empty={!!aiS && aiS.calls === 0}
                visual={
                  aiS && (
                    <Split
                      parts={[
                        {
                          label: t('adminKpi.ai.ok', { defaultValue: 'Succeeded' }),
                          value: Math.max(0, aiS.calls - aiS.errors),
                          tone: 'success',
                        },
                        {
                          label: t('adminKpi.ai.errors', { defaultValue: 'Errors' }),
                          value: aiS.errors,
                          tone: 'destructive',
                        },
                      ]}
                    />
                  )
                }
                stats={[
                  {
                    label: t('adminKpi.ai.calls', { defaultValue: 'Calls' }),
                    value: n(aiS?.calls ?? 0),
                  },
                  {
                    label: t('adminKpi.ai.errors', { defaultValue: 'Errors' }),
                    value: n(aiS?.errors ?? 0),
                    tone: 'bad',
                  },
                  {
                    label: t('adminKpi.ai.cost', { defaultValue: 'Est. cost' }),
                    value: USD.format(aiS?.costUsd ?? 0),
                  },
                  {
                    label: t('adminKpi.ai.latency', { defaultValue: 'Avg latency' }),
                    value: aiS?.avgLatencyMs != null ? `${n(aiS.avgLatencyMs)} ms` : null,
                  },
                ]}
              />
            </Block>
          </div>

          {/* ── 4. Yiji API usage: which account, for what, how it went ───
              Full width, with its own toolbar: the search and the account
              filter only ever narrowed THIS table, so they live with it. */}
          <Block error={yiji.isError} onRetry={() => void yiji.refetch()}>
            <section
              aria-labelledby="admin-kpi-yiji"
              data-section-card=""
              className="space-y-5 rounded-2xl bg-card p-5 shadow-soft ring-1 ring-foreground/[0.06]"
            >
              <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="min-w-0 max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2
                      id="admin-kpi-yiji"
                      className="text-[1.0625rem] font-semibold tracking-tight text-foreground"
                    >
                      {t('adminKpi.yiji.title', { defaultValue: 'Yiji API usage' })}
                    </h2>
                    {y?.lastBackup ? (
                      <Pill tone="warning" size="sm" title={y.lastBackup.fallback_reason ?? ''}>
                        {t('adminKpi.yiji.lastBackup', {
                          defaultValue: 'Backup last used {{when}}',
                          when: formatDateTime(y.lastBackup.date_created),
                        })}
                      </Pill>
                    ) : y ? (
                      <Pill tone="success" size="sm">
                        {t('adminKpi.yiji.neverBackup', { defaultValue: 'Backup never used' })}
                      </Pill>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('adminKpi.yiji.note', {
                      defaultValue:
                        'Every call the CRM made to Yiji. The backup token is used only when the CRM account is refused.',
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchField
                    className="w-full sm:w-64"
                    inputClassName="h-9"
                    value={search}
                    onValueChange={(v) => {
                      setSearch(v);
                      setPage(1);
                    }}
                    aria-label={t('adminKpi.search', { defaultValue: 'Yiji calls' })}
                    placeholder={t('adminKpi.searchPlaceholder', {
                      defaultValue: 'Operation, service or error',
                    })}
                  />
                  <SelectMenu
                    size="sm"
                    className="w-[10.5rem]"
                    aria-label={t('adminKpi.yiji.account', { defaultValue: 'Account' })}
                    value={account}
                    onChange={(v) => {
                      setAccount(v);
                      setPage(1);
                    }}
                    options={[
                      {
                        value: '',
                        label: `${t('adminKpi.yiji.account', { defaultValue: 'Account' })}: ${t('complaintReport.any', { defaultValue: 'Any' })}`,
                      },
                      { value: 'crm', label: accountLabel('crm') },
                      { value: 'backup', label: accountLabel('backup') },
                    ]}
                  />
                  <ClearFiltersButton
                    active={!!search || !!account}
                    onClear={() => {
                      setSearch('');
                      setAccount('');
                      setPage(1);
                    }}
                    label={t('complaintDash.clear', { defaultValue: 'Clear' })}
                  />
                  <ExportCsvButton
                    onExport={exportRecent}
                    count={recent.length}
                    label={t('agentReports.exportCsvCount', {
                      count: recent.length,
                      defaultValue: 'Export CSV ({{count}})',
                    })}
                  />
                </div>
              </header>

              {yiji.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : (
                y && (
                  <div className="grid gap-4 xl:grid-cols-[minmax(17rem,0.8fr)_1fr_1fr]">
                    <div className={PANEL}>
                      <h3 className="mb-3 text-sm font-semibold tracking-tight">
                        {t('adminKpi.yiji.split', { defaultValue: 'Calls by account' })}
                      </h3>
                      <AccountDonut
                        crm={y.totals.crm}
                        backup={y.totals.backup}
                        crmLabel={accountLabel('crm')}
                        backupLabel={accountLabel('backup')}
                        caption={
                          y.totals.total
                            ? t('adminKpi.yiji.crmShare', {
                                defaultValue: '{{pct}}% by the CRM account',
                                pct: Math.round((y.totals.crm / y.totals.total) * 100),
                              })
                            : t('adminKpi.yiji.noCalls', {
                                defaultValue: 'No Yiji calls in this window.',
                              })
                        }
                      />
                      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-foreground/[0.06] pt-3 text-sm">
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {t('adminKpi.yiji.total', { defaultValue: 'Calls' })}
                          </dt>
                          <dd className="font-semibold tabular-nums">{n(y.totals.total)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {t('adminKpi.yiji.failed', { defaultValue: 'Refused / errors' })}
                          </dt>
                          <dd
                            className={cn(
                              'font-semibold tabular-nums',
                              failedCalls > 0 && 'text-destructive',
                            )}
                          >
                            {`${n(y.totals.refused)} / ${n(y.totals.error)}`}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {t('adminKpi.yiji.rateLimited', { defaultValue: 'Rate-limited (429)' })}
                          </dt>
                          <dd
                            className={cn(
                              'font-semibold tabular-nums',
                              (y.rateLimited ?? 0) > 0 && 'text-destructive',
                            )}
                          >
                            {n(y.rateLimited ?? 0)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {t('adminKpi.yiji.breakerOpens', {
                              defaultValue: 'Non-urgent calls paused',
                            })}
                          </dt>
                          <dd
                            className={cn(
                              'font-semibold tabular-nums',
                              (y.breakerOpens ?? 0) > 0 && 'text-destructive',
                            )}
                          >
                            {n(y.breakerOpens ?? 0)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <div className={PANEL}>
                      <h3 className="mb-3 text-sm font-semibold tracking-tight">
                        {t('adminKpi.yiji.trend', { defaultValue: 'Calls per day (UTC)' })}
                      </h3>
                      {y.trend ? (
                        <TrendChart
                          points={y.trend.map((d) => ({
                            label: formatDate(d.day),
                            values: { crm: d.crm, backup: d.backup, failed: d.failed },
                          }))}
                          series={[
                            { key: 'crm', label: accountLabel('crm'), tone: 'primary' },
                            { key: 'backup', label: accountLabel('backup'), tone: 'warning' },
                            {
                              key: 'failed',
                              label: t('adminKpi.yiji.failedShort', { defaultValue: 'Failed' }),
                              tone: 'destructive',
                            },
                          ]}
                          height={140}
                          format={(v) => n(v)}
                          emptyLabel={t('adminKpi.yiji.noCalls', {
                            defaultValue: 'No Yiji calls in this window.',
                          })}
                        />
                      ) : (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                          {t('adminKpi.yiji.trendUnavailable', {
                            defaultValue: 'The daily trend could not be loaded.',
                          })}
                        </p>
                      )}
                    </div>
                    <div className={PANEL}>
                      <h3 className="mb-3 text-sm font-semibold tracking-tight">
                        {t('adminKpi.yiji.byOperation', { defaultValue: 'By operation' })}
                      </h3>
                      <HBarChart
                        rows={y.operations.slice(0, 12).map((o) => ({
                          label: o.operation,
                          values: { crm: o.crm, backup: o.backup },
                          ...(o.refused + o.error > 0
                            ? {
                                note: t('adminKpi.yiji.opFailed', {
                                  defaultValue: '{{count}} failed',
                                  count: o.refused + o.error,
                                }),
                              }
                            : {}),
                        }))}
                        series={[
                          { key: 'crm', label: accountLabel('crm'), tone: 'primary' },
                          { key: 'backup', label: accountLabel('backup'), tone: 'warning' },
                        ]}
                        format={(v) => n(v)}
                        emptyLabel={t('adminKpi.yiji.noCalls', {
                          defaultValue: 'No Yiji calls in this window.',
                        })}
                      />
                    </div>
                  </div>
                )
              )}

              {y?.lastBackup && (
                <p className="text-xs text-muted-foreground">
                  {t('adminKpi.yiji.lastBackupWhy', {
                    defaultValue: 'Last backup use: {{operation}} ({{service}}) - {{reason}}',
                    operation: y.lastBackup.operation,
                    service: y.lastBackup.service,
                    reason: y.lastBackup.fallback_reason ?? '—',
                  })}
                </p>
              )}

              <section aria-labelledby="admin-kpi-yiji-recent" className="space-y-3">
                <h3
                  id="admin-kpi-yiji-recent"
                  className="text-sm font-semibold tracking-tight text-foreground"
                >
                  {t('adminKpi.yiji.recent', {
                    defaultValue: 'Recent failures and backup uses (newest {{limit}})',
                    limit: RECENT_USAGE_LIMIT,
                  })}
                </h3>
                {yiji.isLoading ? (
                  <Skeleton className="h-40 w-full" />
                ) : recent.length === 0 ? (
                  <EmptyState
                    title={t('adminKpi.yiji.recentEmpty', {
                      defaultValue: 'No failures and no backup use in this window.',
                    })}
                  />
                ) : (
                  <TableSurface
                    footer={
                      <TableFooterBar>
                        <TablePager
                          page={page}
                          onPage={setPage}
                          pageSize={pageSize}
                          onPageSize={(s) => {
                            setPageSize(s);
                            setPage(1);
                          }}
                          total={recent.length}
                          pageSizes={PAGE_SIZES}
                          labels={{
                            rowsPerPage: String(
                              t('complaintReport.rowsPerPage', { defaultValue: 'Rows per page' }),
                            ),
                            previous: String(t('agentReports.prev', { defaultValue: 'Previous' })),
                            next: String(t('agentReports.next', { defaultValue: 'Next' })),
                          }}
                        />
                      </TableFooterBar>
                    }
                  >
                    <Table
                      aria-label={t('adminKpi.yiji.recentTable', {
                        defaultValue: 'Yiji failures and backup uses',
                      })}
                    >
                      <thead>
                        <tr>
                          <Th>{t('adminKpi.yiji.col.when', { defaultValue: 'When' })}</Th>
                          <Th>{t('adminKpi.yiji.col.service', { defaultValue: 'Service' })}</Th>
                          <Th>{t('adminKpi.yiji.col.operation', { defaultValue: 'Operation' })}</Th>
                          <Th>{t('adminKpi.yiji.account', { defaultValue: 'Account' })}</Th>
                          <Th>{t('adminKpi.yiji.col.outcome', { defaultValue: 'Outcome' })}</Th>
                          <Th className="text-end">HTTP</Th>
                          <Th>{t('adminKpi.yiji.col.detail', { defaultValue: 'Why / error' })}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((r) => (
                          <Tr key={String(r.id)}>
                            <Td className="whitespace-nowrap tabular-nums">
                              {formatDateTime(r.date_created)}
                            </Td>
                            <Td>{r.service}</Td>
                            <Td className="font-mono text-xs">{r.operation}</Td>
                            <Td>
                              <Pill tone={r.account === 'backup' ? 'warning' : 'neutral'} size="sm">
                                {accountLabel(r.account)}
                              </Pill>
                            </Td>
                            <Td>
                              <Pill
                                tone={
                                  r.outcome === 'ok'
                                    ? 'success'
                                    : r.outcome === 'refused'
                                      ? 'warning'
                                      : 'destructive'
                                }
                                size="sm"
                                dot
                              >
                                {outcomeLabel(r.outcome)}
                              </Pill>
                            </Td>
                            <Td className="text-end tabular-nums">{r.http_status ?? '—'}</Td>
                            <Td className="max-w-[28rem] text-xs text-muted-foreground">
                              {[r.fallback_reason, r.error].filter(Boolean).join(' · ') || '—'}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </TableSurface>
                )}
              </section>
            </section>
          </Block>
        </div>
      </div>
    </div>
  );
}
