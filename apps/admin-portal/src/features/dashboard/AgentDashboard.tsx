import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import { useTranslation } from 'react-i18next';
import {
  cn,
  EmptyState,
  ReportKpi,
  SelectMenu,
  Skeleton,
  Table,
  TableSurface,
  Td,
  Th,
  Toolbar,
  ToolbarSpacer,
  Tr,
  type ReportKpiTone,
} from '@yiji/ui';
import { couponWorth, formatDuration, type CouponValueFact } from '@yiji/reports';
import { directus } from '../../lib/directus.js';
import {
  useAgentReportData,
  type ConversationRow,
  type TicketReportRow,
} from '../report-exports/api.js';

/**
 * The agent-side dashboard: what the support operation is holding right now.
 *
 * Seven numbers and nothing else. The previous single dashboard answered the
 * branch question and the support question at once, in fourteen panels, and the
 * support half was scattered through it — so nobody could open the console and
 * see how many people were waiting without reading past a brand breakdown.
 *
 * Two of the tiles are DOORS. "Waiting for a reply" and "Tickets still open"
 * are the only numbers here somebody can act on, and a count you cannot open is
 * a number you have to go and re-find somewhere else. Clicking either lists the
 * rows behind it, order id first, because the order number is what an agent
 * searches by.
 *
 * Every figure comes from the same query the reports use, so this page and
 * Agent summary cannot disagree about how many chats went unanswered.
 */

const RANGE_DAYS = [7, 30, 90] as const;

/** Coupons raised in the window, for the two money tiles. */
function useCouponFacts(days: number) {
  return useQuery({
    queryKey: ['dashboard-coupons', days],
    staleTime: 60_000,
    queryFn: async (): Promise<CouponValueFact[]> => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const rows = (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            fields: [
              'status',
              'issuing_side',
              'discount_category',
              'coupon_value',
              'coupon_percent',
              'max_discount',
            ],
            filter: { date_created: { _gte: since } },
            limit: -1,
          } as never,
        ),
      )) as unknown as Array<Record<string, unknown>>;
      const num = (v: unknown): number | null => {
        if (v == null || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return rows.map((r) => ({
        status: (r.status as string) ?? null,
        issuingSide: (r.issuing_side as string) ?? null,
        discountCategory: (r.discount_category as string) ?? null,
        couponValue: num(r.coupon_value),
        couponPercent: num(r.coupon_percent),
        maxDiscount: num(r.max_discount),
      }));
    },
  });
}

/** A ticket nobody has finished with. */
const isOpenTicket = (t: TicketReportRow) =>
  !['solved', 'closed', 'resolved'].includes(String(t.status).toLowerCase());

type Drill = 'chats' | 'tickets' | null;

export function AgentDashboard() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [drill, setDrill] = useState<Drill>(null);

  const report = useAgentReportData(days, {
    unassigned: t('agentReports.unassigned', { defaultValue: 'Unassigned' }),
    noSubject: t('agentReports.noSubject', { defaultValue: '(no subject)' }),
  });
  const coupons = useCouponFacts(days);

  const data = report.data;

  const waitingChats = useMemo<ConversationRow[]>(
    () =>
      (data?.conversations.rows ?? [])
        .filter((r) => r.awaitingReply)
        // Longest wait first: the list is a queue to work, not a census.
        .sort((a, b) => (b.waitingMinutes ?? 0) - (a.waitingMinutes ?? 0)),
    [data],
  );
  const openTickets = useMemo<TicketReportRow[]>(
    () => (data?.tickets ?? []).filter(isOpenTicket),
    [data],
  );
  const worth = useMemo(() => couponWorth(coupons.data ?? []), [coupons.data]);

  if (report.isLoading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (report.isError || !data) {
    return (
      <div className="p-6">
        <EmptyState
          title={t('agentReports.loadError', { defaultValue: 'Could not load report data' })}
          description={t('agentReports.loadErrorHint', {
            defaultValue: 'Check your connection and try again.',
          })}
        />
      </div>
    );
  }

  const csat = data.csatOverall.avg;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('agentDash.title', { defaultValue: 'Agent' })}
        </h1>
        <ToolbarSpacer />
        <div className="w-32">
          <SelectMenu
            fullWidth
            value={String(days)}
            onChange={(v) => {
              setDays(Number(v));
              setDrill(null);
            }}
            aria-label={t('agentReports.range', { defaultValue: 'Date range' })}
            options={RANGE_DAYS.map((d) => ({
              value: String(d),
              label: t('agentReports.lastDays', {
                count: d,
                days: d,
                defaultValue: 'Last {{days}} days',
              }),
            }))}
          />
        </div>
      </Toolbar>

      <div className="flex-1 overflow-auto px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <div className="space-y-5">
          {/* Chats ------------------------------------------------------- */}
          <Section title={t('agentDash.chats', { defaultValue: 'Chats' })}>
            <Tiles cols={2}>
              <ReportKpi
                label={t('agentDash.totalChats', { defaultValue: 'Total chats' })}
                value={String(data.conversations.total)}
                tone="blue"
              />
              <OpenableKpi
                label={t('agentDash.waitingChats', { defaultValue: 'Waiting for a reply' })}
                value={String(waitingChats.length)}
                hint={t('agentDash.waitingHint', {
                  defaultValue: 'A customer wrote and nobody has answered',
                })}
                tone="amber"
                open={drill === 'chats'}
                onToggle={() => setDrill(drill === 'chats' ? null : 'chats')}
                openLabel={t('agentDash.showThese', { defaultValue: 'Show these' })}
                hideLabel={t('agentDash.hideThese', { defaultValue: 'Hide' })}
                disabled={waitingChats.length === 0}
              />
            </Tiles>

            {drill === 'chats' && (
              <DrillTable
                empty={t('agentDash.noneWaiting', {
                  defaultValue: 'Nobody is waiting for a first reply.',
                })}
                headers={[
                  t('agentReports.col.orderNumber', { defaultValue: 'Order' }),
                  t('agentReports.col.customer', { defaultValue: 'Customer' }),
                  t('agentReports.col.phone', { defaultValue: 'Phone' }),
                  t('agentReports.col.agent', { defaultValue: 'Agent' }),
                  t('agentDash.waitingFor', { defaultValue: 'Waiting' }),
                ]}
                rows={waitingChats.map((r) => [
                  r.orderId || '—',
                  r.customerName || '—',
                  r.customerPhone || '—',
                  r.agentName,
                  // "10258 min" is a number nobody converts in their head.
                  // The same formatter the performance pages use turns it into
                  // something a person can act on.
                  (r.waitingMinutes == null ? null : formatDuration(r.waitingMinutes * 60)) ?? '—',
                ])}
                keyOf={(_, i) => waitingChats[i]?.id ?? String(i)}
                label={t('agentDash.waitingChats', { defaultValue: 'Waiting for a reply' })}
              />
            )}
          </Section>

          {/* Tickets ----------------------------------------------------- */}
          <Section title={t('agentDash.tickets', { defaultValue: 'Tickets' })}>
            <Tiles cols={2}>
              <ReportKpi
                label={t('agentDash.totalTickets', { defaultValue: 'Total tickets' })}
                value={String(data.tickets.length)}
                tone="violet"
              />
              <OpenableKpi
                label={t('agentDash.openTickets', { defaultValue: 'Tickets still open' })}
                value={String(openTickets.length)}
                hint={t('agentDash.openTicketsHint', {
                  defaultValue: 'Not solved or closed yet',
                })}
                tone="amber"
                open={drill === 'tickets'}
                onToggle={() => setDrill(drill === 'tickets' ? null : 'tickets')}
                openLabel={t('agentDash.showThese', { defaultValue: 'Show these' })}
                hideLabel={t('agentDash.hideThese', { defaultValue: 'Hide' })}
                disabled={openTickets.length === 0}
              />
            </Tiles>

            {drill === 'tickets' && (
              <DrillTable
                empty={t('agentDash.noneOpen', { defaultValue: 'Every ticket is finished.' })}
                headers={[
                  t('agentReports.col.orderNumber', { defaultValue: 'Order' }),
                  t('agentReports.col.subject', { defaultValue: 'Subject' }),
                  t('agentReports.col.contact', { defaultValue: 'Contact' }),
                  t('agentReports.col.agent', { defaultValue: 'Agent' }),
                  t('agentReports.col.status', { defaultValue: 'Status' }),
                ]}
                rows={openTickets.map((r) => [
                  r.order?.orderId || '—',
                  r.subject,
                  r.contactName || r.contactPhone || '—',
                  r.agentName,
                  String(t(`status.${r.status}`, { ns: 'common', defaultValue: r.status })),
                ])}
                keyOf={(_, i) => openTickets[i]?.id ?? String(i)}
                label={t('agentDash.openTickets', { defaultValue: 'Tickets still open' })}
              />
            )}
          </Section>

          {/* Customers and compensation ---------------------------------- */}
          <Section title={t('agentDash.customers', { defaultValue: 'Customers and coupons' })}>
            <Tiles cols={3}>
              <ReportKpi
                label={t('agentDash.rating', { defaultValue: 'Customer rating' })}
                value={csat == null ? '—' : csat.toFixed(2)}
                hint={
                  data.csatOverall.count > 0
                    ? t('agentDash.ratingCount', {
                        count: data.csatOverall.count,
                        defaultValue: 'from {{count}} ratings',
                      })
                    : t('agentDash.ratingNone', { defaultValue: 'nobody has rated yet' })
                }
                tone="green"
              />
              <ReportKpi
                label={t('agentDash.couponsIssued', { defaultValue: 'Coupons issued' })}
                value={String(worth.count)}
                hint={
                  worth.pendingCount > 0
                    ? t('agentDash.couponsPending', {
                        count: worth.pendingCount,
                        defaultValue: '{{count}} still awaiting a decision',
                      })
                    : undefined
                }
                tone="blue"
              />
              <ReportKpi
                label={t('agentDash.couponValue', { defaultValue: 'Value issued (SAR)' })}
                value={new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
                  worth.sar,
                )}
                hint={
                  worth.unpriced > 0
                    ? t('agentDash.couponUnpriced', {
                        count: worth.unpriced,
                        defaultValue: '{{count}} with no riyal figure',
                      })
                    : undefined
                }
                tone="violet"
              />
            </Tiles>
          </Section>
        </div>
      </div>
    </div>
  );
}

/**
 * A row of KPI tiles.
 *
 * ReportKpiStrip hardcodes lg:grid-cols-4, and `cn` is a plain join rather than
 * tailwind-merge — so an override rides ALONGSIDE the base and the winner is
 * decided by stylesheet order. That is how three tiles ended up a quarter of
 * the width they were asked for. Own the grid here instead of arguing with it.
 *
 * Two across on a phone whatever the desktop count: four numerals at this size
 * across 360px is four numbers nobody can read.
 */
function Tiles({ cols, children }: { cols: 2 | 3; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'grid max-w-5xl grid-cols-2 gap-3',
        cols === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3',
      )}
    >
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * A KPI tile that opens.
 *
 * The tile itself stays exactly the tile used everywhere else; the affordance
 * is a button under it rather than the whole card being clickable, because a
 * card that is sometimes a link and sometimes not is a card nobody trusts.
 */
function OpenableKpi({
  label,
  value,
  hint,
  tone,
  open,
  onToggle,
  openLabel,
  hideLabel,
  disabled,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: ReportKpiTone;
  open: boolean;
  onToggle: () => void;
  openLabel: string;
  hideLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <ReportKpi label={label} value={value} hint={hint} tone={tone} />
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className={cn(
          'absolute end-4 top-4 rounded-full px-3 py-1.5 text-2xs font-semibold uppercase tracking-[0.1em]',
          'transition-colors duration-fast',
          disabled
            ? 'cursor-default text-muted-foreground/40'
            : 'text-primary ring-1 ring-inset ring-primary/25 hover:bg-primary/10',
        )}
      >
        {open ? hideLabel : openLabel}
      </button>
    </div>
  );
}

/** The rows behind a number — order id first, because that is what people search by. */
function DrillTable({
  headers,
  rows,
  keyOf,
  empty,
  label,
}: {
  headers: string[];
  rows: string[][];
  keyOf: (row: string[], index: number) => string;
  empty: string;
  label: string;
}) {
  if (rows.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <TableSurface maxHeight="min(50vh, 26rem)" scrollLabel={label}>
      <Table>
        <thead>
          <tr>
            {headers.map((h) => (
              <Th key={h}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <Tr key={keyOf(cells, i)}>
              {cells.map((c, j) => (
                <Td key={j} className={j === 0 ? 'font-mono tabular-nums font-medium' : undefined}>
                  {c}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableSurface>
  );
}
