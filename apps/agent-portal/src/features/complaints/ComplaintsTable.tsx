import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn, Pill, Skeleton, Table, TableSurface, Td, Th, toast, Tr } from '@yiji/ui';
import {
  buildComplaintsSheets,
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
  countUnmappedComplaints,
  downloadWorkbook,
  reportFilename,
  type ComplaintColumnKey,
  type ComplaintReportRow,
  type Translate,
} from '@yiji/reports';

/**
 * The operations complaints table, as the agent sees it.
 *
 * The on-screen preview is the handful of columns that identify a complaint at
 * a glance; the EXPORT carries all 24 in the ops team's order, which is the
 * point of the feature — the sheet has to reconcile against theirs. The column
 * picker chooses what the export contains, not what this table shows, so
 * narrowing the export can never quietly narrow the screen or vice versa.
 */

const STATUS_TONE: Record<string, 'primary' | 'success' | 'warning' | 'muted' | 'neutral'> = {
  new: 'primary',
  open: 'success',
  pending: 'warning',
  resolved: 'primary',
  closed: 'muted',
};

export function ComplaintsTable({
  rows,
  loading,
  selectedId,
  onSelect,
  filenameBase = 'my-complaints',
  days,
}: {
  rows: ComplaintReportRow[];
  loading?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  filenameBase?: string;
  /** Only used to name the workbook; null means "everything". */
  days?: number | null;
}) {
  const { t } = useTranslation();
  const tr = t as unknown as Translate;
  const [cols, setCols] = useState<Set<ComplaintColumnKey>>(() => new Set(COMPLAINT_COLUMN_KEYS));
  const [showCols, setShowCols] = useState(false);

  const unmapped = countUnmappedComplaints(rows);

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
    downloadWorkbook(
      reportFilename(filenameBase, days ?? 0),
      buildComplaintsSheets(rows, tr, chosen),
    );
    toast.success(
      t('complaints.exported', { count: rows.length, defaultValue: 'Exported {{count}} rows.' }),
    );
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-10 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setShowCols((s) => !s)}>
          {t('complaints.columns', { defaultValue: 'Columns' })}{' '}
          <span className="tabular-nums">
            {cols.size}/{COMPLAINT_COLUMN_KEYS.length}
          </span>
        </Button>
        <Button type="button" size="sm" onClick={onExport}>
          {t('complaints.export', { defaultValue: 'Export to Excel' })}
        </Button>
        {/* Each unmapped row is a branch missing from the operations store
            list. It exports as "Not mapped" in every store column, so say so
            here rather than letting someone find it in the sheet. */}
        {unmapped > 0 && (
          <span className="text-xs text-warning">
            {t('complaints.unmappedStores', {
              count: unmapped,
              defaultValue: '{{count}} complaints have a branch that is not in the store list.',
            })}
          </span>
        )}
      </div>

      {showCols && (
        <div className="rounded-2xl bg-card p-4 shadow-soft ring-1 ring-border">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('complaints.columnsHint', {
                defaultValue: 'Choose what the exported sheet contains.',
              })}
            </span>
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

      <TableSurface>
        <Table>
          <thead>
            <tr>
              <Th>{t('complaintReport.col.date', { defaultValue: 'Date' })}</Th>
              <Th>{t('complaintReport.col.time', { defaultValue: 'Time' })}</Th>
              <Th>{t('complaintReport.col.orderNumber', { defaultValue: 'Order number' })}</Th>
              <Th>
                {t('complaintReport.col.restaurantName', { defaultValue: 'Restaurant name' })}
              </Th>
              <Th>{t('complaintReport.col.city', { defaultValue: 'City' })}</Th>
              <Th>{t('complaintReport.col.complaintType', { defaultValue: 'Complaint type' })}</Th>
              <Th>{t('complaintReport.col.customerName', { defaultValue: 'Customer name' })}</Th>
              <Th>{t('complaintReport.col.compensation', { defaultValue: 'Compensation' })}</Th>
              <Th>
                {t('complaintReport.col.complaintStatus', { defaultValue: 'Complaint status' })}
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              // Selecting a row opens the ticket below, so the row is a real
              // control: reachable by Tab and activated by Enter or Space, not
              // a mouse-only click handler.
              <Tr
                key={r.id}
                onClick={onSelect ? () => onSelect(r.id) : undefined}
                tabIndex={onSelect ? 0 : undefined}
                aria-current={selectedId === r.id ? 'true' : undefined}
                onKeyDown={
                  onSelect
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelect(r.id);
                        }
                      }
                    : undefined
                }
                className={cn(
                  onSelect &&
                    'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                  selectedId === r.id && 'bg-primary-subtle/70',
                )}
              >
                <Td className="tabular-nums">{r.date || '—'}</Td>
                <Td className="tabular-nums text-muted-foreground">{r.time || '—'}</Td>
                <Td className="font-mono text-xs">{r.orderNumber || '—'}</Td>
                <Td className="max-w-[14rem] truncate" title={r.restaurantName}>
                  {r.restaurantName || '—'}
                </Td>
                {/* A branch that did not resolve says so, rather than showing a
                    blank city that reads as "this complaint had no branch". */}
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
                <Td className="text-muted-foreground">{r.customerName || '—'}</Td>
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
    </div>
  );
}
