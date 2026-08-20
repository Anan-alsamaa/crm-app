import type { JSX } from 'react';
import { Button } from './Button.js';

export interface ExportButtonsProps {
  /** Export exactly what the page is showing — filters and caps included. */
  onExportView: () => void;
  /** Export everything behind the view: every row, every filter cleared. */
  onExportAll: () => void;
  /** Rows on screen right now. */
  visibleCount: number;
  /** Rows that exist in total. Equal to `visibleCount` when nothing is hidden. */
  totalCount: number;
  /** "Export CSV" — used when the view IS everything and there is one choice. */
  labelPlain: string;
  /** "Export this view (12)" */
  labelView: string;
  /** "Export all (240)" */
  labelAll: string;
  disabled?: boolean;
}

/**
 * Export what you see, or export everything — but only ask when they differ.
 *
 * Every export on this system takes what is ON SCREEN: a filtered view exports
 * the filtered numbers, so the file can never contradict the page that produced
 * it. That is the right default and it is not negotiable — a file that quietly
 * contains rows the person filtered out is how a "the report is wrong" argument
 * starts.
 *
 * But it is not the only thing people want. Someone who has filtered down to
 * one brand to read it often wants the whole set to send on, and re-clearing
 * every filter to get it is both tedious and easy to get half-right.
 *
 * So: when the view already IS everything, this is one plain button and there
 * is no decision to make. The moment a filter or a top-N cap is hiding rows, it
 * becomes two, each carrying its own row count, so the choice is made with the
 * numbers visible rather than from the wording. Offering a choice that has only
 * one real answer is its own kind of noise.
 */
export function ExportButtons({
  onExportView,
  onExportAll,
  visibleCount,
  totalCount,
  labelPlain,
  labelView,
  labelAll,
  disabled,
}: ExportButtonsProps): JSX.Element {
  const somethingHidden = totalCount > visibleCount;

  if (!somethingHidden) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onExportView}
        disabled={disabled || totalCount === 0}
      >
        {labelPlain}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onExportView}
        disabled={disabled || visibleCount === 0}
      >
        {labelView}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onExportAll} disabled={disabled}>
        {labelAll}
      </Button>
    </div>
  );
}
