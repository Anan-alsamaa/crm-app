import type { JSX } from 'react';
import { Button, DownloadIcon } from '@yiji/ui';

/**
 * The one export button every report wears (owner, 2026-10-22: "the export
 * buttons specially in the reports").
 *
 * A pill with a download glyph, the label and the row count, in the same
 * secondary weight as the shared `ExportButtons` (which the console renders
 * with the same glyph), so a report with one export and a report with the
 * "this view / all" pair read as one family.
 *
 * Disabled at zero rows unless the caller states its own condition - every
 * report already disabled its export on an empty result; this keeps that and
 * makes it LOOK disabled (faded, no outline) rather than merely greyed text.
 */
export function ExportCsvButton({
  onExport,
  count,
  label,
  disabled,
  className,
}: {
  onExport: () => void;
  /** Rows the file would carry. Zero disables the button unless `disabled` is given. */
  count: number;
  /** The full label, count included - e.g. `agentReports.exportCsvCount`. */
  label: string;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onExport}
      disabled={disabled ?? count === 0}
      iconStart={<DownloadIcon size={15} />}
      data-export=""
      className={className}
    >
      {label}
    </Button>
  );
}
