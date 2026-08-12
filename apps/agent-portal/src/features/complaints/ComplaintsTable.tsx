import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn, Skeleton, Table, TableSurface, Td, Th, toast, Tr } from '@yiji/ui';
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
  complaintCell,
  moveColumn,
  reconcileColumnOrder,
  loadColumnOrder,
  saveColumnOrder,
  TICKET_REPORT_ORDER_KEY,
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
  // Same arrangement, same storage key as the admin portal: one report, so
  // rearranging it in one place should not fight with the other.
  const [order, setOrder] = useState<ComplaintColumnKey[]>(() =>
    reconcileColumnOrder(
      loadColumnOrder<ComplaintColumnKey>(TICKET_REPORT_ORDER_KEY),
      COMPLAINT_COLUMN_KEYS,
    ),
  );
  const chosenColumns = order.filter((k) => cols.has(k));

  const moveCol = (key: ComplaintColumnKey, delta: number) =>
    setOrder((prev) => {
      const from = prev.indexOf(key);
      const next = moveColumn(prev, from, from + delta);
      saveColumnOrder(TICKET_REPORT_ORDER_KEY, next);
      return next;
    });

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
    downloadWorkbook(
      reportFilename(filenameBase, days ?? 0),
      buildComplaintsSheets(rows, tr, chosenColumns),
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
            {/* Shown in the user's own order, so this list IS the arrangement:
                the arrows move the column in the table and the export too. */}
            {order.map((k, i) => (
              <span
                key={k}
                className="inline-flex items-center gap-0.5 rounded-full bg-secondary/40 ps-0.5 pe-0.5"
              >
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => moveCol(k, -1)}
                  aria-label={t('complaintReport.moveUp', {
                    col: t(COMPLAINT_COLUMN_LABELS[k].key, {
                      defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                    }),
                    defaultValue: 'Move {{col}} earlier',
                  })}
                  className="grid h-5 w-4 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ‹
                </button>
                <button
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
                <button
                  type="button"
                  disabled={i === order.length - 1}
                  onClick={() => moveCol(k, 1)}
                  aria-label={t('complaintReport.moveDown', {
                    col: t(COMPLAINT_COLUMN_LABELS[k].key, {
                      defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                    }),
                    defaultValue: 'Move {{col}} later',
                  })}
                  className="grid h-5 w-4 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  ›
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <TableSurface>
        <Table>
          <thead>
            <tr>
              {chosenColumns.map((k) => (
                <Th key={k}>
                  {t(COMPLAINT_COLUMN_LABELS[k].key, {
                    defaultValue: COMPLAINT_COLUMN_LABELS[k].def,
                  })}
                </Th>
              ))}
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
                {chosenColumns.map((k) => (
                  <Td key={k} className="whitespace-nowrap">
                    {String(complaintCell(r, k, tr) ?? '') || '—'}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableSurface>
    </div>
  );
}
