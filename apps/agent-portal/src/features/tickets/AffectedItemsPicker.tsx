import { useId, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, Input } from '@yiji/ui';
import { formatCaseMoney } from '@yiji/shared-types';
import type { V2OrderLine } from '../../lib/compensation-cases-client.js';

/**
 * AFFECTED ITEMS OF A V2 COMPLAINT (2026-11-18; partner-v1.yaml
 * `OrderItem.order_item_id`).
 *
 * Lists the lines of the ticket's V2 order as the gateway read them through
 * the connector: name, add-ons, quantity and price. The agent ticks the lines
 * the complaint is about and, for each, how many units (1..the line's
 * quantity). The form sends them as `affectedItems [{ orderItemId, quantity }]`;
 * the gateway checks them against the same order read, and V2 checks again.
 *
 * `picks` maps a line id to the quantity field's text (kept as typed so the
 * field can be cleared while editing; the form validates it).
 */

export type ItemPicks = Record<string, string>;

/** The quantity text of a pick as a whole number, or NaN when it is not one. */
export function pickQuantity(text: string): number {
  return /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

export function AffectedItemsPicker({
  lines,
  currency,
  picks,
  onChange,
  required,
  adviseItems,
  loading,
  failed,
  showRequired,
}: {
  lines: V2OrderLine[] | null;
  currency: string | null;
  picks: ItemPicks;
  onChange: (next: ItemPicks) => void;
  /** The chosen category is paid on the items: at least one line is needed. */
  required: boolean;
  /** HAIR / FOREIGN: paid on the items from the second time. */
  adviseItems: boolean;
  loading: boolean;
  failed: boolean;
  /** Say "choose at least one item" (a required category with none picked). */
  showRequired: boolean;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const arabic = (i18n.language ?? '').toLowerCase().startsWith('ar');
  const base = useId();
  const hintId = `${base}-hint`;

  const toggle = (line: V2OrderLine, on: boolean) => {
    const next = { ...picks };
    if (on) next[line.orderItemId] = String(line.quantity);
    else delete next[line.orderItemId];
    onChange(next);
  };

  return (
    <fieldset className="space-y-2" aria-describedby={hintId} data-testid="v2-items-picker">
      <legend className="text-sm font-medium text-foreground">
        {required
          ? t('v2Case.picker.legendRequired', { defaultValue: 'Affected items (required)' })
          : t('v2Case.picker.legendOptional', { defaultValue: 'Affected items (optional)' })}
      </legend>
      <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
        {required
          ? t('v2Case.picker.hintRequired', {
              defaultValue:
                'This category is paid on the items. Choose the items the complaint is about and how many of each.',
            })
          : adviseItems
            ? t('v2Case.picker.hintSecond', {
                defaultValue:
                  'From the second time, this category is paid on the items. Choose them if the customer named any.',
              })
            : t('v2Case.picker.hintOptional', {
                defaultValue: 'Item prices come from the order. Choose items only if they matter.',
              })}
      </p>

      {loading && (
        <div className="space-y-1.5" aria-hidden="true" data-testid="v2-items-loading">
          <div className="h-9 animate-pulse rounded-xl bg-foreground/[0.06] motion-reduce:animate-none" />
          <div className="h-9 animate-pulse rounded-xl bg-foreground/[0.06] motion-reduce:animate-none" />
        </div>
      )}
      {!loading && failed && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('v2Case.picker.failed', {
            defaultValue: 'The order’s items could not be read from Yiji V2. Try again shortly.',
          })}
        </p>
      )}
      {!loading && !failed && lines && lines.length === 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('v2Case.picker.none', { defaultValue: 'This order has no items to choose.' })}
        </p>
      )}

      {!loading && !failed && lines && lines.length > 0 && (
        <ul className="divide-y divide-foreground/[0.06] rounded-xl bg-card ring-1 ring-inset ring-foreground/[0.06]">
          {lines.map((line) => {
            const id = `${base}-${line.orderItemId}`;
            const picked = line.orderItemId in picks;
            const text = picks[line.orderItemId] ?? '';
            const q = pickQuantity(text);
            const bad = picked && (!Number.isInteger(q) || q < 1 || q > line.quantity);
            const name = (arabic && line.nameAr) || line.name;
            return (
              <li
                key={line.orderItemId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                data-testid="v2-item-line"
              >
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  checked={picked}
                  onChange={(e) => toggle(line, e.target.checked)}
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <span dir="auto" className="block truncate text-sm text-foreground">
                    {name}
                  </span>
                  {line.modifiers.length > 0 && (
                    <span dir="auto" className="block truncate text-xs text-muted-foreground">
                      {line.modifiers.join(', ')}
                    </span>
                  )}
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    {t('v2Case.picker.lineMeta', {
                      defaultValue: 'Quantity {{quantity}} · {{price}} each',
                      quantity: line.quantity,
                      price: formatCaseMoney(line.unitPriceMinor, currency),
                    })}
                  </span>
                </label>
                {picked && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={line.quantity}
                      step={1}
                      value={text}
                      invalid={bad}
                      className={cn('h-8 w-16 px-2 tabular-nums')}
                      aria-label={t('v2Case.picker.quantityLabel', {
                        defaultValue: 'Affected quantity of {{name}}',
                        name,
                      })}
                      onChange={(e) => onChange({ ...picks, [line.orderItemId]: e.target.value })}
                    />
                    <span className="tabular-nums">
                      {t('v2Case.picker.ofQuantity', {
                        defaultValue: 'of {{quantity}}',
                        quantity: line.quantity,
                      })}
                    </span>
                  </span>
                )}
                {bad && (
                  <p role="alert" className="basis-full text-xs text-destructive">
                    {t('v2Case.picker.quantityRange', {
                      defaultValue: 'Enter a whole number from 1 to {{max}}.',
                      max: line.quantity,
                    })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {showRequired && (
        <p className="text-xs text-destructive" data-testid="v2-items-required">
          {t('v2Case.picker.required', {
            defaultValue: 'Choose at least one item for this category.',
          })}
        </p>
      )}
    </fieldset>
  );
}
