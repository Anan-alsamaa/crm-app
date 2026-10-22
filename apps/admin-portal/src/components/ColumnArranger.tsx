import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, cn, Drawer, Input } from '@yiji/ui';
import { moveColumn } from '@yiji/reports';

/**
 * Choose and ORDER a report's columns (owner, 2026-10-13: "column sequencing"
 * on the report pages). The Ticket breakdown's arranger, made reusable: drag a
 * row, or use the arrows (the keyboard path); tick to show or hide. The order
 * here is the order in the table AND the export. The caller owns and persists
 * both the order and the visible set.
 */
export interface ColumnArrangerProps<K extends string> {
  open: boolean;
  onClose: () => void;
  /** Every arrangeable key, in the current order. */
  order: readonly K[];
  onOrder: (next: K[]) => void;
  visible: ReadonlySet<K>;
  onToggle: (key: K) => void;
  /** The default order, for "Reset order". */
  defaults: readonly K[];
  labelOf: (key: K) => string;
}

export function ColumnArranger<K extends string>({
  open,
  onClose,
  order,
  onOrder,
  visible,
  onToggle,
  defaults,
  labelOf,
}: ColumnArrangerProps<K>) {
  const { t } = useTranslation();
  const [dragKey, setDragKey] = useState<K | null>(null);
  const [query, setQuery] = useState('');
  const move = (key: K, delta: number) => {
    const from = order.indexOf(key);
    onOrder(moveColumn(order, from, from + delta));
  };
  const arrow =
    'grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('agentReports.exportColumns', { defaultValue: 'Columns' })}
      description={t('complaintReport.columnsHelp', {
        defaultValue:
          'Drag a row to reorder. The order here is the order in the table and the export.',
      })}
      width="lg"
      footer={
        <Button onClick={onClose}>
          {t('actions.done', { ns: 'common', defaultValue: 'Done' })}
        </Button>
      }
    >
      <div className="flex h-full flex-col">
        <div className="space-y-2 border-b border-foreground/[0.08] p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">
              {t('complaintReport.shownCount', {
                defaultValue: '{{n}} of {{m}} shown',
                n: order.filter((k) => visible.has(k)).length,
                m: order.length,
              })}
            </span>
            <button
              type="button"
              className="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => onOrder([...defaults])}
            >
              {t('complaintReport.resetOrder', { defaultValue: 'Reset order' })}
            </button>
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 text-xs"
            aria-label={t('complaintReport.findColumn', { defaultValue: 'Find a column' })}
            placeholder={t('complaintReport.findColumn', { defaultValue: 'Find a column…' })}
          />
        </div>
        <ul className="flex-1 space-y-0.5 overflow-auto p-3">
          {order.map((k, i) => {
            const label = labelOf(k);
            // Filtering hides rows but never renumbers them.
            if (query.trim() && !label.toLowerCase().includes(query.toLowerCase())) return null;
            return (
              <li
                key={k}
                draggable
                onDragStart={(e) => {
                  setDragKey(k);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setDragKey(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKey && dragKey !== k) {
                    onOrder(moveColumn(order, order.indexOf(dragKey), order.indexOf(k)));
                  }
                  setDragKey(null);
                }}
                className={cn('flex items-center gap-1 rounded-lg', dragKey === k && 'opacity-40')}
              >
                <span
                  aria-hidden
                  className="shrink-0 cursor-grab select-none px-1 text-muted-foreground/60 active:cursor-grabbing"
                  title={t('complaintReport.dragHint', { defaultValue: 'Drag to reorder' })}
                >
                  ⠿
                </span>
                <span className="w-5 shrink-0 text-end text-2xs tabular-nums text-muted-foreground/70">
                  {i + 1}
                </span>
                <label className="flex flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-xs text-foreground hover:bg-secondary/60">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-border accent-primary focus:ring-primary/60"
                    checked={visible.has(k)}
                    onChange={() => onToggle(k)}
                  />
                  {label}
                </label>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(k, -1)}
                  aria-label={t('complaintReport.moveUp', {
                    col: label,
                    defaultValue: 'Move {{col}} earlier',
                  })}
                  className={arrow}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === order.length - 1}
                  onClick={() => move(k, 1)}
                  aria-label={t('complaintReport.moveDown', {
                    col: label,
                    defaultValue: 'Move {{col}} later',
                  })}
                  className={arrow}
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(k, -i)}
                  aria-label={t('complaintReport.moveFirst', {
                    col: label,
                    defaultValue: 'Move {{col}} to the front',
                  })}
                  title={t('complaintReport.moveFirst', {
                    col: label,
                    defaultValue: 'Move {{col}} to the front',
                  })}
                  className={arrow}
                >
                  ⤒
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Drawer>
  );
}
