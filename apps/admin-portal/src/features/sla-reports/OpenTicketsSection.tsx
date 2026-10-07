import { useTranslation } from 'react-i18next';
import {
  Avatar,
  ClockIcon,
  InboxIcon,
  Pill,
  ReportKpi,
  ReportKpiStrip,
  ShieldIcon,
  Spinner,
  Table,
  TableSurface,
  Td,
  Th,
  Tr,
  ZapIcon,
} from '@yiji/ui';
import { DUE_SOON_HOURS, useOpenTicketStats, type OpenBacklogRow } from './open-tickets.js';

const PRIORITY_TONE: Record<string, 'muted' | 'neutral' | 'warning' | 'destructive'> = {
  low: 'muted',
  medium: 'neutral',
  high: 'warning',
  urgent: 'destructive',
};

/**
 * "Open tickets" — the backlog still pending, right now (owner, 2026-10-07).
 *
 * Sits ABOVE the deadlines report and ignores its date range on purpose — see
 * `useOpenTicketStats`. The note under the heading says so, because a block of
 * numbers that does not move when the dates change reads as broken unless it
 * explains itself.
 */
export function OpenTicketsSection() {
  const { t } = useTranslation();
  const q = useOpenTicketStats();
  const d = q.data;

  const unassigned = String(t('slaReports.open.unassigned', { defaultValue: 'Unassigned' }));
  const noBrand = String(t('slaReports.open.noBrand', { defaultValue: 'No brand' }));

  return (
    <section
      aria-labelledby="sla-open-tickets"
      className="sticky start-0 w-[var(--pin-w,100%)] space-y-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="sla-open-tickets" className="text-sm font-semibold tracking-tight text-foreground">
          {t('slaReports.open.title', { defaultValue: 'Open tickets' })}
        </h2>
        <p className="min-w-0 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          {t('slaReports.open.note', {
            defaultValue:
              'Every ticket still pending, as of now — not limited to the dates below, because a ticket raised months ago and still unsolved is open work today.',
          })}
        </p>
      </div>

      {q.isLoading ? (
        <div className="flex h-16 items-center justify-center">
          <Spinner />
        </div>
      ) : !d ? (
        <p className="rounded-xl bg-secondary/50 px-4 py-3 text-xs text-muted-foreground">
          {t('slaReports.open.failed', {
            defaultValue: 'The open-ticket figures could not be loaded. Refresh to try again.',
          })}
        </p>
      ) : (
        <>
          <ReportKpiStrip>
            <ReportKpi
              label={String(t('slaReports.open.kpiPending', { defaultValue: 'Pending' }))}
              value={String(d.total)}
              tone="blue"
              icon={<InboxIcon size={18} />}
            />
            <ReportKpi
              label={String(t('slaReports.open.kpiOverdue', { defaultValue: 'Overdue' }))}
              value={String(d.overdue)}
              tone="amber"
              icon={<ShieldIcon size={18} />}
            />
            <ReportKpi
              label={String(
                t('slaReports.open.kpiDueSoon', {
                  hours: DUE_SOON_HOURS,
                  defaultValue: 'Due within {{hours}}h',
                }),
              )}
              value={String(d.dueSoon)}
              tone="violet"
              icon={<ClockIcon size={18} />}
            />
            <ReportKpi
              label={String(t('slaReports.open.kpiNoDeadline', { defaultValue: 'No deadline' }))}
              value={String(d.noDeadline)}
              tone="green"
              icon={<ZapIcon size={18} />}
            />
          </ReportKpiStrip>

          {d.total > 0 && (
            <>
              {/* By priority as counted pills: four numbers are a line to read,
                  not a table to scroll. */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t('slaReports.open.byPriority', { defaultValue: 'By priority' })}
                </span>
                {d.byPriority.map((p) => (
                  <Pill key={p.key} tone={PRIORITY_TONE[p.key] ?? 'neutral'} size="sm">
                    {t(`priority.${p.key}`, { ns: 'common', defaultValue: p.key })}
                    <span className="ms-1 tabular-nums">{p.count}</span>
                  </Pill>
                ))}
              </div>

              <div className="grid max-w-6xl gap-3 lg:grid-cols-2">
                <BacklogTable
                  label={String(t('slaReports.open.byAgent', { defaultValue: 'By agent' }))}
                  nameHeader={String(t('slaReports.colAgent', { defaultValue: 'Agent' }))}
                  rows={d.byAgent}
                  nullName={unassigned}
                  avatar
                />
                <BacklogTable
                  label={String(t('slaReports.open.byBrand', { defaultValue: 'By brand' }))}
                  nameHeader={String(t('slaReports.open.colBrand', { defaultValue: 'Brand' }))}
                  rows={d.byBrand}
                  nullName={noBrand}
                />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function BacklogTable({
  label,
  nameHeader,
  rows,
  nullName,
  avatar = false,
}: {
  label: string;
  nameHeader: string;
  rows: OpenBacklogRow[];
  nullName: string;
  avatar?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <TableSurface maxHeight="18rem" scrollLabel={label}>
      <Table aria-label={label}>
        <thead>
          <tr>
            <Th>{nameHeader}</Th>
            <Th className="text-end">
              {t('slaReports.open.colPending', { defaultValue: 'Pending' })}
            </Th>
            <Th className="text-end">
              {t('slaReports.open.colOverdue', { defaultValue: 'Overdue' })}
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = r.key === null ? nullName : r.name;
            return (
              <Tr key={r.key ?? '__none__'}>
                <Td className="max-w-[16rem]">
                  <span className="flex min-w-0 items-center gap-2">
                    {avatar && <Avatar size="xs" name={name} />}
                    <span className="min-w-0 truncate" title={name}>
                      {name}
                    </span>
                  </span>
                </Td>
                <Td className="text-end tabular-nums">{r.pending}</Td>
                <Td
                  className={
                    r.overdue > 0
                      ? 'text-end font-semibold tabular-nums text-destructive'
                      : 'text-end tabular-nums text-muted-foreground'
                  }
                >
                  {r.overdue}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </TableSurface>
  );
}
