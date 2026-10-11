import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Drawer, Input, cn } from '@yiji/ui';
import { moveColumn } from '@yiji/reports';
import {
  LATE_ORDER_COLUMN_KEYS,
  saveLateOrderColumnOrder,
  saveLateOrderHiddenColumns,
  toggleHiddenColumn,
  type LateOrderColumnKey,
} from './columns.js';

/**
 * "Columns n/m" and the drawer behind it — the same picker the admin portal's
 * tickets breakdown uses (owner, 2026-10-11): drag to reorder, arrows as the
 * keyboard path, a checkbox to show or hide, All, Reset order and a find box.
 *
 * Every change is saved to this browser as it is made; the page owns the state
 * so the table and the picker can never disagree.
 */
export function LateOrderColumnsPicker({
  order,
  hidden,
  onOrder,
  onHidden,
  labelOf,
}: {
  order: readonly LateOrderColumnKey[];
  hidden: ReadonlySet<LateOrderColumnKey>;
  onOrder: (next: LateOrderColumnKey[]) => void;
  onHidden: (next: Set<LateOrderColumnKey>) => void;
  labelOf: (key: LateOrderColumnKey) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** The column currently being dragged, if any. */
  const [dragKey, setDragKey] = useState<LateOrderColumnKey | null>(null);
  const total = LATE_ORDER_COLUMN_KEYS.length;
  const shown = total - hidden.size;

  const commitOrder = (next: LateOrderColumnKey[]) => {
    saveLateOrderColumnOrder(next);
    onOrder(next);
  };
  const commitHidden = (next: Set<LateOrderColumnKey>) => {
    saveLateOrderHiddenColumns(next);
    onHidden(next);
  };
  const moveCol = (key: LateOrderColumnKey, delta: number) => {
    const from = order.indexOf(key);
    if (from < 0) return;
    commitOrder(moveColumn(order, from, from + delta));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground ring-1 ring-border transition-colors duration-fast hover:bg-secondary hover:text-foreground"
      >
        {t('lateOrders.columns.button', { defaultValue: 'Columns' })}
        <span className="tabular-nums opacity-70">
          {shown}/{total}
        </span>
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('lateOrders.columns.title', { defaultValue: 'Columns' })}
        description={t('lateOrders.columns.help', {
          defaultValue: 'Drag a row to reorder. The order here is the order in the table.',
        })}
        width="lg"
        footer={
          <Button onClick={() => setOpen(false)}>
            {t('actions.done', { ns: 'common', defaultValue: 'Done' })}
          </Button>
        }
      >
        <div className="flex h-full flex-col">
          <div className="space-y-2 border-b border-border p-4">
            <div className="flex items-center justify-between">
              <span className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                {t('lateOrders.columns.shownCount', {
                  defaultValue: '{{n}} of {{m}} shown',
                  n: shown,
                  m: total,
                })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-2xs font-medium text-primary hover:underline"
                  onClick={() => commitHidden(new Set())}
                >
                  {t('lateOrders.columns.selectAll', { defaultValue: 'All' })}
                </button>
                <button
                  type="button"
                  className="text-2xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => commitOrder([...LATE_ORDER_COLUMN_KEYS])}
                >
                  {t('lateOrders.columns.resetOrder', { defaultValue: 'Reset order' })}
                </button>
              </div>
            </div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 text-xs"
              aria-label={t('lateOrders.columns.find', { defaultValue: 'Find a column' })}
              placeholder={t('lateOrders.columns.findPlaceholder', {
                defaultValue: 'Find a column…',
              })}
            />
          </div>
          <ul className="flex-1 space-y-0.5 overflow-auto p-3">
            {order.map((k, i) => {
              const label = labelOf(k);
              // Filtering hides rows but never renumbers them: the position
              // shown is the real position in the table.
              if (query.trim() && !label.toLowerCase().includes(query.trim().toLowerCase())) {
                return null;
              }
              const on = !hidden.has(k);
              return (
                <li
                  key={k}
                  draggable
                  data-column={k}
                  onDragStart={(e) => {
                    setDragKey(k);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!dragKey || dragKey === k) return;
                    const from = order.indexOf(dragKey);
                    const to = order.indexOf(k);
                    setDragKey(null);
                    if (from < 0 || to < 0) return;
                    commitOrder(moveColumn(order, from, to));
                  }}
                  className={cn(
                    'flex items-center gap-1 rounded-lg',
                    dragKey === k && 'opacity-40',
                  )}
                >
                  {/* Drag to reorder; the arrows stay as the keyboard path. */}
                  <span
                    aria-hidden
                    className="shrink-0 cursor-grab select-none px-1 text-muted-foreground/60 active:cursor-grabbing"
                    title={t('lateOrders.columns.dragHint', { defaultValue: 'Drag to reorder' })}
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
                      checked={on}
                      /* At least one column always stays: the last one shown
                         cannot be switched off. */
                      disabled={on && shown <= 1}
                      onChange={() => commitHidden(toggleHiddenColumn(hidden, k))}
                    />
                    {label}
                  </label>
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => moveCol(k, -1)}
                    aria-label={t('lateOrders.columns.moveUp', {
                      col: label,
                      defaultValue: 'Move {{col}} earlier',
                    })}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === order.length - 1}
                    onClick={() => moveCol(k, 1)}
                    aria-label={t('lateOrders.columns.moveDown', {
                      col: label,
                      defaultValue: 'Move {{col}} later',
                    })}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </Drawer>
    </>
  );
}
