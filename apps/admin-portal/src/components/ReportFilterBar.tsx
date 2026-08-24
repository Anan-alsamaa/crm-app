import { useEffect, useMemo, useState } from 'react';
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
 *
 * NOTHING APPLIES UNTIL YOU SAY SO. Every control used to write straight
 * through, so a report re-queried and re-sorted on each keystroke and each
 * half-typed date — the table moving under the hands of somebody still
 * deciding what to ask. The bar holds a DRAFT and pushes it up on Apply (or
 * Enter). The applied values still arrive as props, so a shortcut that writes
 * them from outside — the quick-range preset — shows up here immediately,
 * which is what a shortcut is for.
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

  /*
   * What is typed but not yet asked for.
   *
   * Seeded from the applied values and re-seeded whenever THOSE change, so a
   * quick-range preset writing the dates from outside lands in the fields
   * immediately. Typing only moves the draft, so that effect does not fire and
   * cannot yank a half-typed value back.
   */
  const [draftSearch, setDraftSearch] = useState(search);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [draftSelects, setDraftSelects] = useState<Record<string, string>>({});

  useEffect(() => setDraftSearch(search), [search]);
  useEffect(() => setDraftFrom(from), [from]);
  useEffect(() => setDraftTo(to), [to]);

  /** Applied select values, keyed — the baseline the draft is compared to. */
  const appliedSelects = useMemo(
    () => Object.fromEntries(selects.map((s) => [s.key, s.value])),
    [selects],
  );
  // Re-seed on an EXTERNAL change (Clear, or a value the parent reset), keyed
  // on the values themselves rather than the array identity — `selects` is
  // rebuilt inline on every render, so watching it would reset every keystroke.
  const appliedKey = JSON.stringify(appliedSelects);
  useEffect(() => setDraftSelects({}), [appliedKey]);

  const valueOf = (s: FilterSelect) => draftSelects[s.key] ?? s.value;

  const dirty =
    draftSearch !== search ||
    draftFrom !== from ||
    draftTo !== to ||
    selects.some((s) => valueOf(s) !== s.value);

  const apply = () => {
    if (draftSearch !== search) onSearch(draftSearch);
    if (draftFrom !== from) onFrom(draftFrom);
    if (draftTo !== to) onTo(draftTo);
    for (const s of selects) {
      const next = valueOf(s);
      if (next !== s.value) s.onChange(next);
    }
  };

  const clear = () => {
    setDraftSearch('');
    setDraftFrom('');
    setDraftTo('');
    setDraftSelects({});
    onClear();
  };

  const hasSecondRow = selects.length > 0;

  return (
    <form
      // A real form, so Enter anywhere inside it applies — the reflex anybody
      // typing into a search box already has, and the reason a bare Apply
      // button on its own feels like a step backwards from auto-applying.
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      /* PINNED against the horizontal scroll.
         In flow mode the page itself scrolls sideways so the table can reach
         its far columns, and everything else on the page would ride along —
         scroll right to read "Response" and the filters you were using slide
         out of the window behind you. These blocks are only ever as wide as
         the viewport, so sticking them to the start edge keeps them exactly
         where they were while the table alone moves. */
      className="sticky start-0 z-[5] w-[var(--pin-w,100%)] shrink-0 space-y-2 rounded-2xl bg-card p-2.5 shadow-soft ring-1 ring-foreground/[0.06]"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1" style={{ minWidth: '18rem' }}>
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {searchLabel}
          </span>
          <Input
            value={draftSearch}
            onChange={(e) => setDraftSearch(e.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('complaintDash.from', { defaultValue: 'From' })}
          </span>
          <DateField className="w-[9.5rem]" value={draftFrom} onChange={setDraftFrom} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {t('complaintDash.to', { defaultValue: 'To' })}
          </span>
          <DateField className="w-[9.5rem]" value={draftTo} onChange={setDraftTo} />
        </label>
        {rangePreset && <div className="flex w-36 items-end">{rangePreset}</div>}
        {!hasSecondRow && <FilterActions {...{ dirty, filtering, apply, clear, actions, t }} />}
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
                value={valueOf(s)}
                onChange={(v) => setDraftSelects((prev) => ({ ...prev, [s.key]: v }))}
                options={[
                  { value: '', label: t('complaintReport.any', { defaultValue: 'Any' }) },
                  ...s.options,
                ]}
              />
            </label>
          ))}
          <FilterActions {...{ dirty, filtering, apply, clear, actions, t }} />
        </div>
      )}
    </form>
  );
}

/**
 * Apply, Clear, and whatever the report puts beside them.
 *
 * Apply is always present rather than appearing only when something changed: a
 * button that comes and goes is one people stop looking for, and its disabled
 * state is what says "there is nothing waiting" — which is information.
 */
function FilterActions({
  dirty,
  filtering,
  apply,
  clear,
  actions,
  t,
}: {
  dirty: boolean;
  filtering: boolean;
  apply: () => void;
  clear: () => void;
  actions?: ReactNode;
  t: (key: string, opts?: Record<string, unknown>) => unknown;
}): JSX.Element {
  return (
    <div className="ms-auto flex flex-wrap items-end gap-2">
      {filtering && (
        <Button type="button" size="sm" variant="ghost" onClick={clear}>
          {String(t('inbox.clearFilters', { defaultValue: 'Clear filters' }))}
        </Button>
      )}
      <Button type="submit" size="sm" onClick={apply} disabled={!dirty}>
        {dirty
          ? String(t('complaintReport.applyPending', { defaultValue: 'Apply changes' }))
          : String(t('complaintReport.apply', { defaultValue: 'Apply' }))}
      </Button>
      {actions}
    </div>
  );
}
