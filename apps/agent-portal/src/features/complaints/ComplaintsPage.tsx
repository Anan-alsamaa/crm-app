import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  cn,
  EmptyState,
  Pagination,
  Pill,
  SelectMenu,
  Skeleton,
  Table,
  TableSurface,
  Td,
  Th,
  toast,
  Toolbar,
  ToolbarSpacer,
  Tr,
} from '@yiji/ui';
import {
  buildComplaintsSheets,
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
  countUnmappedComplaints,
  downloadWorkbook,
  joinComplaintStores,
  reportFilename,
  type ComplaintColumnKey,
  type ComplaintReportRow,
  type Translate,
} from '@yiji/reports';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useStoreIndex } from '../tickets/useStoreMatch.js';
import { useMyComplaints } from './api.js';

/**
 * The agent's own complaints, in the operations team's report format.
 *
 * The same 24 columns and the same export the operations manager reads, so an
 * agent can answer "what did I log, and in the shape you want it" without
 * asking anyone. The rows are the agent's own — see api.ts for why that scope
 * is stated in the query and not merely inherited from the role.
 */

const RANGE_DAYS = [7, 30, 90] as const;
const PAGE_SIZE = 10;

const STATUS_TONE: Record<string, 'primary' | 'success' | 'warning' | 'muted' | 'neutral'> = {
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
};

export function ComplaintsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const tr = t as unknown as Translate;

  const agentName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() ||
    user?.email ||
    t('complaints.you', { defaultValue: 'You' });

  const [days, setDays] = useState<number>(30);
  const [page, setPage] = useState(1);
  const [cols, setCols] = useState<Set<ComplaintColumnKey>>(() => new Set(COMPLAINT_COLUMN_KEYS));
  const [showCols, setShowCols] = useState(false);

  const q = useMyComplaints(days, agentName);
  const { index: storeIndex } = useStoreIndex();

  // Same join as the manager's report, so one complaint is attributed to one
  // branch no matter who is looking at it.
  const rows = useMemo<ComplaintReportRow[]>(
    () => joinComplaintStores(q.data ?? [], storeIndex),
    [q.data, storeIndex],
  );
  const unmapped = useMemo(() => countUnmappedComplaints(rows), [rows]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageRows = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const toggleCol = (k: ComplaintColumnKey) =>
    setCols((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const onExport = () => {
    if (rows.length === 0) {
      toast.error(t('complaints.nothingToExport', { defaultValue: 'Nothing to export.' }));
      return;
    }
    const chosen = COMPLAINT_COLUMN_KEYS.filter((k) => cols.has(k));
    // The export is ALWAYS the full result set — paging only limits the
    // preview above, never what lands in the workbook.
    downloadWorkbook(
      reportFilename('my-complaints', days),
      buildComplaintsSheets(rows, tr, chosen),
    );
    toast.success(
      t('complaints.exported', { count: rows.length, defaultValue: 'Exported {{count}} rows.' }),
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          {t('complaints.title', { defaultValue: 'My complaints' })}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('complaints.subtitle', {
            defaultValue:
              'The complaints assigned to you, in the format the operations team export.',
          })}
        </p>
      </div>

      <Toolbar>
        <SelectMenu
          value={String(days)}
          onChange={(v) => {
            setDays(Number(v));
            setPage(1);
          }}
          aria-label={t('complaints.range', { defaultValue: 'Date range' })}
          options={RANGE_DAYS.map((d) => ({
            value: String(d),
            label: t('complaints.lastDays', { count: d, defaultValue: 'Last {{count}} days' }),
          }))}
        />
        <ToolbarSpacer />
        <Button type="button" variant="outline" size="sm" onClick={() => setShowCols((s) => !s)}>
          {t('complaints.columns', { defaultValue: 'Columns' })}{' '}
          <span className="tabular-nums">
            {cols.size}/{COMPLAINT_COLUMN_KEYS.length}
          </span>
        </Button>
        <Button type="button" size="sm" onClick={onExport} disabled={q.isLoading}>
          {t('complaints.export', { defaultValue: 'Export to Excel' })}
        </Button>
      </Toolbar>

      {showCols && (
        <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-border">
          <div className="mb-3 flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCols(new Set(COMPLAINT_COLUMN_KEYS))}
            >
              {t('complaints.allColumns', { defaultValue: 'All' })}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {COMPLAINT_COLUMN_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => toggleCol(k)}
                aria-pressed={cols.has(k)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-fast',
                  cols.has(k)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary/60 text-muted-foreground ring-1 ring-border hover:text-foreground',
                )}
              >
                {t(COMPLAINT_COLUMN_LABELS[k].key, {
                  defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                })}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Each unmapped row is a branch missing from the operations store list.
          Worth saying out loud: those rows export with "Not mapped" in every
          store column, and someone has to add the store to fix them. */}
      {unmapped > 0 && (
        <p className="text-xs text-warning">
          {t('complaints.unmappedStores', {
            count: unmapped,
            defaultValue: '{{count}} complaints have a branch that is not in the store list.',
          })}
        </p>
      )}

      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('complaints.empty', { defaultValue: 'No complaints in this period.' })}
          description={t('complaints.emptyHint', {
            defaultValue: 'Complaints you are assigned appear here, newest first.',
          })}
        />
      ) : (
        <>
          <TableSurface>
            <Table>
              <thead>
                <tr>
                  <Th>{t('complaintReport.col.date', { defaultValue: 'Date' })}</Th>
                  <Th>{t('complaintReport.col.time', { defaultValue: 'Time' })}</Th>
                  <Th>
                    {t('complaintReport.col.restaurantName', { defaultValue: 'Restaurant name' })}
                  </Th>
                  <Th>{t('complaintReport.col.city', { defaultValue: 'City' })}</Th>
                  <Th>
                    {t('complaintReport.col.complaintType', { defaultValue: 'Complaint type' })}
                  </Th>
                  <Th>{t('complaintReport.col.serviceType', { defaultValue: 'Service type' })}</Th>
                  <Th>{t('complaintReport.col.compensation', { defaultValue: 'Compensation' })}</Th>
                  <Th>
                    {t('complaintReport.col.complaintStatus', { defaultValue: 'Complaint status' })}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="tabular-nums">{r.date || '—'}</Td>
                    <Td className="tabular-nums text-muted-foreground">{r.time || '—'}</Td>
                    <Td className="max-w-[14rem] truncate" title={r.restaurantName}>
                      {r.restaurantName || '—'}
                    </Td>
                    {/* A branch that did not resolve says so, rather than
                        showing a blank city that reads as "no branch". */}
                    {r.restaurantName || r.brand ? (
                      r.storeMapped ? (
                        <Td className="text-muted-foreground">{r.city || '—'}</Td>
                      ) : (
                        <Td>
                          <Pill tone="warning" size="sm">
                            {t('agentReports.notMapped', { defaultValue: 'Not mapped' })}
                          </Pill>
                        </Td>
                      )
                    ) : (
                      <Td className="text-muted-foreground">—</Td>
                    )}
                    <Td className="text-muted-foreground">{r.complaintType || '—'}</Td>
                    <Td className="text-muted-foreground">{r.serviceType || '—'}</Td>
                    <Td className="text-muted-foreground">{r.compensation || '—'}</Td>
                    <Td>
                      <Pill tone={STATUS_TONE[r.complaintStatus] ?? 'neutral'} size="sm">
                        {t(`status.${r.complaintStatus}`, {
                          ns: 'common',
                          defaultValue: r.complaintStatus,
                        })}
                      </Pill>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableSurface>

          <p className="text-2xs text-muted-foreground">
            {t('complaints.previewNote', {
              shown: pageRows.length,
              total: rows.length,
              defaultValue: 'Showing {{shown}} of {{total}}. The export contains all rows.',
            })}
          </p>
          <Pagination
            page={current}
            pageCount={pageCount}
            onPage={setPage}
            prevLabel={t('complaints.prev', { defaultValue: 'Previous' })}
            nextLabel={t('complaints.next', { defaultValue: 'Next' })}
          />
        </>
      )}
    </div>
  );
}
