/**
 * The one CSV writer every report exports through.
 *
 * There used to be three: a correct one in the stores feature, a partial one
 * inlined in the SLA page, and none at all on the four reports that shipped
 * `.xlsx` instead. They disagreed in ways nobody would notice until the file
 * was opened by a person who then reported "the export is broken":
 *
 *  - **No BOM** meant Excel read the file as the local codepage, so every
 *    Arabic name — which is most of them — arrived as mojibake.
 *  - **`\n` endings** are legal per RFC 4180's tolerant readers but Excel on
 *    Windows is happier with CRLF, and some older importers are not tolerant.
 *  - **No formula guard** meant a subject beginning `=` or `+` was executed by
 *    Excel on open. A complaint reading `=cmd|...` is not a hypothetical for a
 *    field customers type into.
 *
 * So: quote per RFC 4180, CRLF rows, UTF-8 BOM, neutralise formulas. One
 * function, used everywhere, and a file that says the same thing as the screen
 * that produced it.
 */

/** Columns are described once and then used for both the header and the cells. */
export interface CsvColumn<T> {
  /** Header text — already translated by the caller. */
  header: string;
  /** Pull this column's value out of a row. Return `null` for a blank cell. */
  value: (row: T) => string | number | null | undefined;
}

/**
 * Excel and Sheets treat a leading `=`, `+`, `-` or `@` as a formula, so a
 * value a customer typed can execute on open. Prefixing with an apostrophe is
 * the standard neutraliser: the cell still READS as the original text.
 *
 * Numbers are exempt — `-5` is a number, not an injection, and quoting it
 * would turn a numeric column into text and break every SUM downstream.
 */
function neutralise(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** RFC 4180: wrap in quotes when the value could otherwise break the row. */
function cell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const s = neutralise(String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header row and rows of plain values. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const lines = [header.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  // The BOM is what makes Excel read this as UTF-8 rather than the local
  // codepage. Without it every Arabic name in the file is mojibake.
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** Build a CSV from typed rows and a column list — the shape reports use. */
export function rowsToCsv<T>(columns: ReadonlyArray<CsvColumn<T>>, rows: readonly T[]): string {
  return toCsv(
    columns.map((c) => c.header),
    rows.map((r) => columns.map((c) => c.value(r))),
  );
}

/**
 * Hand a generated CSV to the browser as a download.
 *
 * The anchor is appended to the document before clicking: a detached anchor
 * works in Chrome but is ignored by Firefox, which is the kind of bug that only
 * ever reproduces on somebody else's machine.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Build the rows, name the file and hand it over — the whole export, one call. */
export function exportCsv<T>(
  filename: string,
  columns: ReadonlyArray<CsvColumn<T>>,
  rows: readonly T[],
): void {
  downloadCsv(filename, rowsToCsv(columns, rows));
}
