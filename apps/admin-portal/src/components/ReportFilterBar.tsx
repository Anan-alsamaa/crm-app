import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DateField, Input, SelectMenu } from '@yiji/ui';

/**
 * The filter bar every report wears.
 *
 * Ticket breakdown had one and the other four did not, so "find the tickets
 * Amjad handled last week" was a different job on every page — and on three of
 * them, not a job you could do at all.
 *
 * The anatomy is Ticket breakdown's, because that is the one people already
 * know: free text across the top because it answers most questions on its own,
 * the date range beside it, and the dropdowns underneath for slicing rather
 * than finding.
 *
 * Options come from the ROWS IN RANGE, never from an enum. A list of every
 * agent who has ever worked here, on a report covering last week, is a menu to
 * read past — and choosing an absent value returns an empty table that looks
 * like a fault rather than an answer.
 */

export interface FilterSelect {
  /** Stable key, used for the field name and as the React key. */
  key: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Values actually present in the data. Rendered under an "Any" option. */
  options: Array<{ value: string; label: string }>;
}

export interface ReportFilterBarProps {
  searchLabel: string;
  searchPlaceholder: string;
  search: string;
  onSearch: (v: string) => void;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  selects?: FilterSelect[];
  /** True when anything is narrowing the set — shows Clear. */
  filtering: boolean;
  onClear: () => void;
  /**
   * Export (and anything else that acts on the filtered set), rendered on the
   * bar's own line.
   *
   * It used to sit in a band of its own between the filters and the table: a
   * full row, 60px with its gap, holding one button. Four such economies —
   * this row, the KPI tiles, the description and the outer gaps — are why the
   * table started 585px down a screen that is often 620 CSS pixels tall. The
   * export also BELONGS here: what it writes is whatever these controls have
   * narrowed to, and putting the two together says so.
   */
  actions?: ReactNode;
  /**
   * The "last 7 / 30 / 90 days" shortcut, beside the dates it writes.
   *
   * It used to live in a toolbar of its own above the report — a 60px band
   * whose only other content was the report's name, which the tab strip
   * directly above it was already showing as a selected pill. Two bands, one
   * fact. The shortcut belongs next to the two dates it sets anyway: a control
   * that writes fields you cannot see is a control you have to test to trust.
   */
  rangePreset?: ReactNode;
}

export function ReportFilterBar({
  searchLabel,
  searchPlaceholder,
  search,
  onSearch,
  from,
  to,
  onFrom,
  onTo,
  selects = [],
  filtering,
  onClear,
  actions,
  rangePreset,
}: ReportFilterBarProps): JSX.Element {
  const { t } = useTranslation();
  const hasSecondRow = selects.length > 0 || filtering;
  return (
    <div className="shrink-0 space-y-2 rounded-2xl bg-card p-2.5 shadow-soft ring-1 ring-foreground/[0.06]">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1" style={{ minWidth: '18rem' }}>
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {searchLabel}
          </span>
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('complaintDash.from', { defaultValue: 'From' })}
          </span>
          <DateField className="w-[9.5rem]" value={from} onChange={onFrom} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('complaintDash.to', { defaultValue: 'To' })}
          </span>
          <DateField className="w-[9.5rem]" value={to} onChange={onTo} />
        </label>
        {rangePreset && <div className="flex w-36 items-end">{rangePreset}</div>}
        {/* On a wide bar the actions ride the first row; they drop to the
            second only when there is one. */}
        {actions && !hasSecondRow && <div className="ms-auto flex items-end">{actions}</div>}
      </div>

      {hasSecondRow && (
        <div className="flex flex-wrap items-end gap-2">
          {selects.map((s) => (
            <label key={s.key} className="flex flex-col gap-1">
              <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {s.label}
              </span>
              <SelectMenu
                size="sm"
                className="w-[10rem]"
                aria-label={s.label}
                value={s.value}
                onChange={s.onChange}
                options={[
                  { value: '', label: t('complaintReport.any', { defaultValue: 'Any' }) },
                  ...s.options,
                ]}
              />
            </label>
          ))}
          {filtering && (
            <Button type="button" size="sm" variant="ghost" onClick={onClear}>
              {t('inbox.clearFilters', { defaultValue: 'Clear filters' })}
            </Button>
          )}
          {actions && <div className="ms-auto flex items-end">{actions}</div>}
        </div>
      )}
    </div>
  );
}
