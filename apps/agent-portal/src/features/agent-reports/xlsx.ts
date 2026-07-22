/**
 * Minimal, dependency-free `.xlsx` (SpreadsheetML) writer.
 *
 * Why hand-rolled rather than SheetJS: an `.xlsx` is just a ZIP of XML parts, and
 * this monorepo runs RAM-tight with no guaranteed network at build time (see the
 * project working model + dev-machine notes). Pulling a heavy binary dependency
 * for what amounts to tabular export is a liability; instead we emit the handful
 * of OOXML parts Excel needs and pack them with the ZIP *stored* method (no
 * compression, so no deflate implementation required). The result is a valid
 * workbook that Excel, LibreOffice Calc and Google Sheets all open cleanly.
 *
 * Scope is deliberately small: strings + numbers, one bold header row per sheet,
 * multiple sheets. Dates are written as pre-formatted strings by the caller so we
 * never have to deal with Excel's 1900 serial-date epoch.
 */

export interface SheetColumn {
  header: string;
  /** Column width in Excel character units (optional; sensible default applied). */
  width?: number;
}

/** A single cell value. `null`/`undefined` render as an empty cell. */
export type CellValue = string | number | null | undefined;

export interface Sheet {
  /** Tab name. Excel caps at 31 chars and forbids `[]:*?/\` — sanitised below. */
  name: string;
  columns: SheetColumn[];
  rows: CellValue[][];
}

/* ── CRC-32 (needed by the ZIP container) ─────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ── XML helpers ──────────────────────────────────────────────────────── */

const enc = new TextEncoder();

/** Escape the five XML predefined entities so any user text is safe in a part. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strip the control characters XML 1.0 forbids. Report data can carry stray
 * newlines/tabs from message bodies; tab + newline are legal, the rest are not
 * and make Excel refuse the file, so drop them defensively.
 */
function stripInvalid(s: string): string {
  // Drop the C0 control range XML 1.0 forbids (everything below 0x20 except
  // tab, LF and CR) - message bodies can carry stray control bytes that would
  // otherwise make Excel refuse the file. Done char-by-char to keep the source
  // free of literal control characters.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += s[i];
  }
  return out;
}

/** A1-style column letter for a 0-based index (0 → A, 26 → AA). */
function colLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim() || fallback;
  return cleaned.slice(0, 31);
}

function sheetXml(sheet: Sheet): string {
  const colCount = sheet.columns.length;
  const cols = sheet.columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${(c.width ?? 18).toFixed(2)}" customWidth="1"/>`,
    )
    .join('');

  const cell = (value: CellValue, rowIdx: number, colIdx: number, styleId: number): string => {
    const ref = `${colLetter(colIdx)}${rowIdx + 1}`;
    const s = styleId ? ` s="${styleId}"` : '';
    if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c r="${ref}"${s}><v>${value}</v></c>`;
    }
    const text = stripInvalid(String(value));
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  };

  const headerRow = `<row r="1">${sheet.columns
    .map((c, i) => cell(c.header, 0, i, 1))
    .join('')}</row>`;

  const dataRows = sheet.rows
    .map((row, r) => {
      const cells: string[] = [];
      for (let c = 0; c < colCount; c++) cells.push(cell(row[c], r + 1, c, 0));
      return `<row r="${r + 2}">${cells.join('')}</row>`;
    })
    .join('');

  const lastCol = colLetter(Math.max(colCount - 1, 0));
  const dim = `A1:${lastCol}${sheet.rows.length + 1}`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dim}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    (colCount ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${headerRow}${dataRows}</sheetData>` +
    `</worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  // A named "Normal" style — strict readers (and Excel's repair check) expect a
  // default cell style to exist.
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

function contentTypesXml(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    overrides +
    `</Types>`
  );
}

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

function workbookXml(names: string[]): string {
  const sheets = names
    .map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets}</sheets></workbook>`
  );
}

function workbookRelsXml(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  // Styles relationship id must not collide with the sheet ids above.
  const stylesRel = `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels +
    stylesRel +
    `</Relationships>`
  );
}

/* ── ZIP container (stored / no compression) ──────────────────────────── */

interface ZipEntry {
  path: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** Pack a set of named parts into a ZIP (stored entries) — a valid `.xlsx`. */
function zip(parts: { path: string; content: string }[]): Blob {
  const encoded = parts.map((p) => ({ path: p.path, data: enc.encode(p.content) }));

  // 1) Local headers + file data.
  const localChunks: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const part of encoded) {
    const nameBytes = enc.encode(part.path);
    const crc = crc32(part.data);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    writeUint32(view, 0, 0x04034b50); // local file header signature
    writeUint16(view, 4, 20); // version needed
    writeUint16(view, 6, 0x0800); // flags: UTF-8 filenames
    writeUint16(view, 8, 0); // compression: stored
    writeUint16(view, 10, 0); // mod time
    writeUint16(view, 12, 0x21); // mod date (1980-01-01)
    writeUint32(view, 14, crc);
    writeUint32(view, 18, part.data.length); // compressed size
    writeUint32(view, 22, part.data.length); // uncompressed size
    writeUint16(view, 26, nameBytes.length);
    writeUint16(view, 28, 0); // extra length
    header.set(nameBytes, 30);

    entries.push({ path: part.path, data: part.data, crc, offset });
    localChunks.push(header, part.data);
    offset += header.length + part.data.length;
  }

  // 2) Central directory.
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.path);
    const rec = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(rec.buffer);
    writeUint32(view, 0, 0x02014b50); // central dir signature
    writeUint16(view, 4, 20); // version made by
    writeUint16(view, 6, 20); // version needed
    writeUint16(view, 8, 0x0800); // flags: UTF-8
    writeUint16(view, 10, 0); // compression: stored
    writeUint16(view, 12, 0); // mod time
    writeUint16(view, 14, 0x21); // mod date
    writeUint32(view, 16, e.crc);
    writeUint32(view, 20, e.data.length); // compressed size
    writeUint32(view, 24, e.data.length); // uncompressed size
    writeUint16(view, 28, nameBytes.length);
    writeUint16(view, 30, 0); // extra length
    writeUint16(view, 32, 0); // comment length
    writeUint16(view, 34, 0); // disk number start
    writeUint16(view, 36, 0); // internal attrs
    writeUint32(view, 38, 0); // external attrs
    writeUint32(view, 42, e.offset); // local header offset
    rec.set(nameBytes, 46);
    centralChunks.push(rec);
    centralSize += rec.length;
  }

  // 3) End of central directory.
  const eocd = new Uint8Array(22);
  const eview = new DataView(eocd.buffer);
  writeUint32(eview, 0, 0x06054b50);
  writeUint16(eview, 4, 0); // disk number
  writeUint16(eview, 6, 0); // disk with central dir
  writeUint16(eview, 8, entries.length); // entries this disk
  writeUint16(eview, 10, entries.length); // total entries
  writeUint32(eview, 12, centralSize);
  writeUint32(eview, 16, offset); // central dir offset
  writeUint16(eview, 20, 0); // comment length

  // Cast to BlobPart[]: TS 5.7's lib widens `Uint8Array#buffer` to
  // ArrayBufferLike (could be a SharedArrayBuffer), which the Blob overload
  // rejects — our buffers are always plain ArrayBuffers, so the cast is safe.
  const chunks = [...localChunks, ...centralChunks, eocd] as unknown as BlobPart[];
  return new Blob(chunks, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ── Public API ───────────────────────────────────────────────────────── */

/** Build an `.xlsx` workbook Blob from one or more sheets. */
export function buildWorkbook(sheets: Sheet[]): Blob {
  const safe = sheets.length ? sheets : [{ name: 'Sheet1', columns: [], rows: [] }];
  const names: string[] = [];
  const seen = new Set<string>();
  const normalized = safe.map((s, i) => {
    let name = sanitizeSheetName(s.name, `Sheet${i + 1}`);
    // Excel rejects duplicate tab names — disambiguate.
    let candidate = name;
    let n = 2;
    while (seen.has(candidate.toLowerCase())) {
      const suffix = ` (${n++})`;
      candidate = name.slice(0, 31 - suffix.length) + suffix;
    }
    name = candidate;
    seen.add(name.toLowerCase());
    names.push(name);
    return { ...s, name };
  });

  const parts: { path: string; content: string }[] = [
    { path: '[Content_Types].xml', content: contentTypesXml(normalized.length) },
    { path: '_rels/.rels', content: ROOT_RELS_XML },
    { path: 'xl/workbook.xml', content: workbookXml(names) },
    { path: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml(normalized.length) },
    { path: 'xl/styles.xml', content: STYLES_XML },
    ...normalized.map((s, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      content: sheetXml(s),
    })),
  ];

  return zip(parts);
}

/** Build a workbook and trigger a browser download. */
export function downloadWorkbook(filename: string, sheets: Sheet[]): void {
  const blob = buildWorkbook(sheets);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
