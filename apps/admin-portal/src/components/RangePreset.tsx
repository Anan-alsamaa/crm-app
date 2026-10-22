import type { JSX } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectMenu } from '@yiji/ui';
import { defaultReportRange, isoDay } from '../lib/date-range.js';

/**
 * 365 is here because the history is: the imported operations sheet reaches
 * back to December, and 90 days stops in June — so the longest shortcut showed
 * barely half of what the report holds, and seeing the rest meant typing two
 * dates by hand every time.
 */

const RANGE_DAYS = [7, 30, 90, 365] as const;

/** The remembered range, handed down so each report's filter bar can drive it. */
export interface RangeProps {
  range: {
    from: string;
    to: string;
    setFrom: (v: string) => void;
    setTo: (v: string) => void;
    /** Both ends at once — what the quick-range shortcut writes. */
    setRange: (r: { from: string; to: string }) => void;
    reset: () => void;
  };
}

/**
 * "Last 7 / 30 / 90 days", rendered inside the filter bar beside the dates.
 *
 * A shortcut, not a second source of truth: picking a preset WRITES the two
 * dates next to it, so the shortcut and the fields can never disagree about
 * which period is on screen. It sat in a toolbar of its own until the toolbar
 * turned out to be 60px of screen saying what the tab strip above it already
 * said.
 */
export function RangePreset({ range }: RangeProps): JSX.Element {
  const { t } = useTranslation();
  /**
   * Which preset the dates currently ARE, so the menu can say so.
   *
   * It used to be pinned to "" and so always read "Quick range", whatever had
   * been picked — on the reports where the two date fields sit beside it that
   * was merely quiet, but the ticket breakdown reads its whole period from
   * this control, and a control that never shows its own value looks like a
   * control that did not work.
   *
   * Derived rather than remembered: the dates are the truth, and a stored
   * selection would go stale the moment someone typed a date by hand. A range
   * that matches no preset falls back to the placeholder, which is honest —
   * "last 47 days" is not one of the choices.
   */
  const active = useMemo(() => {
    if (!range.from || !range.to) return '';
    // The application default (owner, 2026-10-15) has its own name.
    const def = defaultReportRange();
    if (range.from === def.from && range.to === def.to) return 'default';
    if (range.to !== isoDay(new Date())) return '';
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000);
    return RANGE_DAYS.includes(days as (typeof RANGE_DAYS)[number]) ? String(days) : '';
  }, [range.from, range.to]);

  return (
    <SelectMenu
      fullWidth
      value={active}
      onChange={(v) => {
        // The placeholder is not a period: re-picking it should leave the
        // dates alone rather than silently resetting them to today..today.
        if (!v) return;
        if (v === 'default') {
          range.setRange(defaultReportRange());
          return;
        }
        const n = Number(v);
        const now = new Date();
        range.setRange({
          from: isoDay(new Date(now.getTime() - n * 86_400_000)),
          to: isoDay(now),
        });
      }}
      aria-label={t('agentReports.range', { defaultValue: 'Date range' })}
      options={[
        { value: '', label: t('agentReports.presets', { defaultValue: 'Quick range' }) },
        {
          value: 'default',
          label: t('agentReports.yesterdayToday', { defaultValue: 'Yesterday and today' }),
        },
        ...RANGE_DAYS.map((d) => ({
          value: String(d),
          label: t('agentReports.lastDays', {
            count: d,
            days: d,
            defaultValue: 'Last {{days}} days',
          }),
        })),
      ]}
    />
  );
}
