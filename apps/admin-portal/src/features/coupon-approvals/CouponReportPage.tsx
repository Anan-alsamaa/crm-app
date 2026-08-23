import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { readItems } from '@directus/sdk';
import {
  Button,
  Card,
  MeterBar,
  Skeleton,
  Table,
  TableSurface,
  Td,
  Th,
  Toolbar,
  ToolbarSpacer,
  Tr,
} from '@yiji/ui';
import {
  couponOutcomes,
  couponOutcomesByAgent,
  couponRate,
  type CouponApprovalFact,
} from '@yiji/reports';
import { exportFileName } from '@yiji/shared-config';
import { directus } from '../../lib/directus.js';
import { downloadCsv, toCsv } from '../restaurants/csv.js';

/**
 * What happens to the coupons agents ask for.
 *
 * The three rates on top answer the question a supervisor actually has — are we
 * turning people down, or quietly rewriting their numbers? — and the table
 * below says who. Amended approvals are counted apart from straight ones
 * throughout: both went through, but only one went through as asked, and the
 * difference is the whole reason this page exists.
 */
function useCouponFacts() {
  return useQuery({
    queryKey: ['coupon-approval-facts'],
    staleTime: 60_000,
    queryFn: async (): Promise<CouponApprovalFact[]> => {
      const rows = (await directus.request(
        readItems(
          'coupon_approvals' as never,
          {
            limit: -1,
            fields: ['status', 'edited_by_admin', { requested_by: ['id', 'first_name', 'email'] }],
          } as never,
        ),
      )) as unknown as Array<{
        status: string | null;
        edited_by_admin: boolean | null;
        requested_by: { id: string; first_name: string | null; email: string | null } | null;
      }>;
      return rows.map((r) => ({
        status: r.status,
        editedByAdmin: r.edited_by_admin,
        requestedById: r.requested_by?.id ?? null,
        // `||` not `??`: an unset name is an empty string, not null.
        requestedByName: r.requested_by?.first_name?.trim() || r.requested_by?.email || null,
      }));
    },
  });
}

function Rate({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | null;
  hint: string;
  tone: 'success' | 'destructive' | 'sky';
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-[2.25rem] font-extrabold leading-none tracking-[-0.03em] tabular-nums">
        {value === null ? (
          // Not 0% — nothing has been decided, which is a different statement.
          <span className="text-base font-semibold text-muted-foreground">
            {t('couponReport.noDecisions', { defaultValue: 'Nothing decided yet' })}
          </span>
        ) : (
          `${Math.round(value)}%`
        )}
      </p>
      <div className="mt-3">
        <MeterBar value={value ?? 0} tone={tone} />
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">{hint}</p>
    </Card>
  );
}

export function CouponReportPage() {
  const { t } = useTranslation();
  const facts = useCouponFacts();

  const total = useMemo(() => couponOutcomes(facts.data ?? []), [facts.data]);
  const rows = useMemo(
    () =>
      couponOutcomesByAgent(
        facts.data ?? [],
        t('performance.unknownAgent', { defaultValue: 'Unknown agent' }),
      ),
    [facts.data, t],
  );

  /**
   * The per-agent table, as a file.
   *
   * The TOTAL row goes out too, and it goes out FIRST: the per-agent rows
   * include an "unknown agent" bucket precisely so the parts add up to the
   * whole, and an export that dropped the total would throw that away.
   * Approved-as-asked and approved-with-changes stay in separate columns here
   * for the same reason they are separate on screen — collapsing them into one
   * "approved" number hides the finding the report exists to surface.
   */
  const exportCsv = () => {
    const header = [
      t('couponReport.agent', { defaultValue: 'Agent' }),
      t('couponReport.requested', { defaultValue: 'Requested' }),
      t('couponReport.asAsked', { defaultValue: 'Approved as asked' }),
      t('couponReport.withChanges', { defaultValue: 'Approved with changes' }),
      t('couponReport.approvedTotal', { defaultValue: 'Approved (total)' }),
      t('couponReport.rejected', { defaultValue: 'Rejected' }),
      t('couponReport.pending', { defaultValue: 'Waiting on a decision' }),
      t('couponReport.approvedRatePct', { defaultValue: 'Approved rate (% of decided)' }),
    ];
    const line = (name: string, r: typeof total) => {
      const rate = couponRate(r.approvedTotal, r);
      return [
        name,
        r.requested,
        r.approvedAsAsked,
        r.approvedWithChanges,
        r.approvedTotal,
        r.rejected,
        r.pending,
        // Blank, not 0, when nothing has been decided — 0% would read as "we approve nothing".
        rate === null ? '' : Math.round(rate),
      ];
    };
    const body = [
      line(t('couponReport.allAgents', { defaultValue: 'All agents' }), total),
      ...rows.map((r) => line(r.agentName, r)),
    ];
    downloadCsv(exportFileName('Coupon approvals', {}), toCsv(header, body));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar>
        <h1 className="text-sm font-semibold tracking-tight text-foreground">
          {t('couponReport.title', { defaultValue: 'Coupon approvals' })}
        </h1>
        <ToolbarSpacer />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={exportCsv}
          disabled={total.requested === 0}
        >
          {t('stores.export', { defaultValue: 'Export CSV' })}
        </Button>
      </Toolbar>

      <div className="flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-6xl space-y-5">
          <div className="border-b border-foreground/10 pb-5">
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t('couponReport.hint', {
                defaultValue:
                  'Every coupon an agent asked for, and what a supervisor did with it. Rates are a share of the requests that have been DECIDED — a queued request is not a refusal.',
              })}
            </p>
          </div>

          {facts.isLoading ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Skeleton className="h-40 w-full rounded-2xl" />
              <Skeleton className="h-40 w-full rounded-2xl" />
              <Skeleton className="h-40 w-full rounded-2xl" />
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Rate
                  label={t('couponReport.approvedRate', { defaultValue: 'Approved' })}
                  value={couponRate(total.approvedTotal, total)}
                  tone="success"
                  hint={t('couponReport.approvedHint', {
                    defaultValue: 'Went through, whether or not the terms were changed first.',
                  })}
                />
                <Rate
                  label={t('couponReport.amendedRate', { defaultValue: 'Approved with changes' })}
                  value={couponRate(total.approvedWithChanges, total)}
                  tone="sky"
                  hint={t('couponReport.amendedHint', {
                    defaultValue:
                      'A supervisor granted something other than what was asked for. High here means agents and supervisors disagree about what a ticket is worth.',
                  })}
                />
                <Rate
                  label={t('couponReport.rejectedRate', { defaultValue: 'Rejected' })}
                  value={couponRate(total.rejected, total)}
                  tone="destructive"
                  hint={t('couponReport.rejectedHint', {
                    defaultValue: 'Turned down outright.',
                  })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl bg-card px-4 py-3 text-sm shadow-soft ring-1 ring-foreground/[0.06]">
                <Count
                  label={t('couponReport.requested', { defaultValue: 'Requested' })}
                  n={total.requested}
                />
                <Count
                  label={t('couponReport.asAsked', { defaultValue: 'As asked' })}
                  n={total.approvedAsAsked}
                />
                <Count
                  label={t('couponReport.withChanges', { defaultValue: 'With changes' })}
                  n={total.approvedWithChanges}
                />
                <Count
                  label={t('couponReport.rejected', { defaultValue: 'Rejected' })}
                  n={total.rejected}
                />
                <Count
                  label={t('couponReport.pending', { defaultValue: 'Waiting' })}
                  n={total.pending}
                />
              </div>

              <TableSurface>
                <Table>
                  <thead>
                    <Tr>
                      <Th>{t('couponReport.agent', { defaultValue: 'Agent' })}</Th>
                      <Th className="text-end">
                        {t('couponReport.requested', { defaultValue: 'Requested' })}
                      </Th>
                      <Th className="text-end">
                        {t('couponReport.asAsked', { defaultValue: 'As asked' })}
                      </Th>
                      <Th className="text-end">
                        {t('couponReport.withChanges', { defaultValue: 'With changes' })}
                      </Th>
                      <Th className="text-end">
                        {t('couponReport.rejected', { defaultValue: 'Rejected' })}
                      </Th>
                      <Th className="text-end">
                        {t('couponReport.pending', { defaultValue: 'Waiting' })}
                      </Th>
                      <Th className="text-end">
                        {t('couponReport.approvedRate', { defaultValue: 'Approved' })}
                      </Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <Tr>
                        <Td colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                          {t('couponReport.none', { defaultValue: 'No coupon requests yet.' })}
                        </Td>
                      </Tr>
                    ) : (
                      rows.map((r) => {
                        const rate = couponRate(r.approvedTotal, r);
                        return (
                          <Tr key={r.agentId ?? 'none'}>
                            <Td className="font-medium text-foreground">{r.agentName}</Td>
                            <Td className="text-end tabular-nums">{r.requested}</Td>
                            <Td className="text-end tabular-nums">{r.approvedAsAsked}</Td>
                            <Td className="text-end tabular-nums">{r.approvedWithChanges}</Td>
                            <Td className="text-end tabular-nums">{r.rejected}</Td>
                            <Td className="text-end tabular-nums text-muted-foreground">
                              {r.pending}
                            </Td>
                            <Td className="text-end tabular-nums font-semibold">
                              {rate === null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                `${Math.round(rate)}%`
                              )}
                            </Td>
                          </Tr>
                        );
                      })
                    )}
                  </tbody>
                </Table>
              </TableSurface>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-base font-bold tabular-nums text-foreground">{n}</span>
      <span className="text-2xs uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
    </span>
  );
}
