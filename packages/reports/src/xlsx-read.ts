/**
 * Minimal, dependency-free `.xlsx` READER — the import-side twin of xlsx.ts.
 *
 * Same reasoning as the writer: an .xlsx is a ZIP of XML parts, and the few we
 * need (sharedStrings + the first worksheet) parse with a page of code. What a
 * library would add — styles, formulas, charts, merged-cell geometry — is
 * exactly what a complaints import must ignore anyway.
 *
 * ZIP entries come in two flavours here: STORED (what our own writer emits) and
 * DEFLATE (what Excel itself saves). Deflate goes through the platform's
 * `DecompressionStream('deflate-raw')`, which exists in every modern browser
 * and in Node 18+ — still no dependency.
 *
 * XML is parsed with regular expressions, deliberately: `DOMParser` does not
 * exist in Node, and SpreadsheetML's cell markup is machine-written and
 * regular. This is not a general XML parser and must never grow into one.
 */

export type XlsxCell = string | number | null;

/* ── ZIP container ────────────────────────────────────────────────────── */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readEntries(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End-of-central-directory: scan backwards for its signature. The comment
  // field caps at 64KB, so the scan is bounded.
  let eocd = -1;
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not_a_zip');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extract(buf: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = entry.localHeaderOffset;
  if (view.getUint32(at, true) !== 0x04034b50) throw new Error('bad_local_header');
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const data = buf.subarray(
    at + 30 + nameLen + extraLen,
    at + 30 + nameLen + extraLen + entry.compressedSize,
  );
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`unsupported_compression_${entry.method}`);
}

/* ── SpreadsheetML ────────────────────────────────────────────────────── */

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/** All the <t> runs inside one string item, concatenated (rich text splits them). */
const textOf = (xml: string): string => {
  let out = '';
  for (const m of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]!);
  return out;
};

/** `"BC"` → 54 (0-based). */
const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * Parse the FIRST worksheet into a dense row matrix.
 *
 * Cell types honoured: shared strings, inline strings, formula string results,
 * booleans, and raw numbers. Dates stay as their serial NUMBERS — whether a
 * number is a date is a question about the COLUMN it is in, which only the
 * caller's header row can answer (see `excelSerialToIsoDate`).
 */
export async function readXlsxRows(buffer: ArrayBuffer): Promise<XlsxCell[][]> {
  const buf = new Uint8Array(buffer);
  const entries = readEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const sheetEntry =
    byName.get('xl/worksheets/sheet1.xml') ??
    entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheetEntry) throw new Error('no_worksheet');

  const shared: string[] = [];
  const sharedEntry = byName.get('xl/sharedStrings.xml');
  if (sharedEntry) {
    const xml = new TextDecoder().decode(await extract(buf, sharedEntry));
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));
  }

  const xml = new TextDecoder().decode(await extract(buf, sheetEntry));
  const rows: XlsxCell[][] = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: XlsxCell[] = [];
    for (const cm of rowMatch[1]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const body = cm[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /t="([a-z]+)"/i.exec(attrs)?.[1] ?? '';
      const idx = ref ? colIndex(ref) : cells.length;

      let value: XlsxCell = null;
      if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v === undefined) value = null;
        else if (type === 's') value = shared[Number(v)] ?? null;
        else if (type === 'str') value = unescapeXml(v);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else value = Number(v);
      }
      cells[idx] = value;
    }
    // Sparse refs leave holes; normalise to nulls so callers can index freely.
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows.push(cells);
  }
  return rows;
}

/* ── Excel serial dates ───────────────────────────────────────────────── */

const EXCEL_EPOCH_OFFSET_DAYS = 25569; // 1970-01-01 in Excel's 1900 system

/** `45123.0` → `2023-07-16`. Fractions (time of day) are dropped by design. */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 61) return null; // pre-1900-03-01: not real data here
  const ms = Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * 86400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** `0.798...` (fraction of a day) → `19:11`. */
export function excelSerialToTime(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const frac = serial % 1;
  const totalMinutes = Math.round(frac * 24 * 60);
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
