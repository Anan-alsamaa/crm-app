/**
 * CSV parsing for the stores import.
 *
 * Deliberately NOT the naive `line.split(',')` used by the contacts importer:
 * branch names in the operations sheet contain commas ("Riyadh, Al Nakheel"),
 * and a naive split silently shifts every later column one place left — the
 * city ends up in the manager field and nothing errors.
 */
import { splitStoreCode } from '@yiji/shared-types';

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parse a whole CSV/TSV document into a header + rows. Tabs are accepted too. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const clean = text.replace(/^\uFEFF/, ''); // strip a BOM from Excel exports
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  // Excel "Save as ... Text (tab delimited)" is a very common way to get this
  // data out, so accept it rather than producing one giant single column.
  const isTab = (lines[0]!.match(/\t/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0);
  const split = (l: string) => (isTab ? l.split('\t').map((s) => s.trim()) : splitCsvLine(l));
  const header = split(lines[0]!);
  const rows = lines.slice(1).map(split);
  return { header, rows };
}

export interface ParsedStoreRow {
  code: string | null;
  name: string;
  city: string | null;
  areaManager: string | null;
  chainManager: string | null;
  brandCode: string | null;
  yijiRestaurantId: string | null;
}

export interface ParseStoresResult {
  rows: ParsedStoreRow[];
  /** 1-based source line numbers that were skipped, with the reason. */
  skipped: Array<{ line: number; reason: string }>;
  /** Header names we could not place, echoed back so a typo is visible. */
  unmappedHeaders: string[];
}

const HEADER_ALIASES: Record<string, keyof ParsedStoreRow | 'ignore'> = {
  restaurant: 'name',
  'restaurant name': 'name',
  store: 'name',
  'store name': 'name',
  branch: 'name',
  name: 'name',
  city: 'city',
  area: 'areaManager',
  'area manager': 'areaManager',
  areamanager: 'areaManager',
  chain: 'chainManager',
  'chain manager': 'chainManager',
  chainmanager: 'chainManager',
  brand: 'brandCode',
  'brand code': 'brandCode',
  'yiji restaurant id': 'yijiRestaurantId',
  'restaurant id': 'yijiRestaurantId',
  yiji_restaurant_id: 'yijiRestaurantId',
  code: 'code',
  'store code': 'code',
};

/**
 * "LCP-002 Marina Mall 2" → { code: "LCP-002", name: "Marina Mall 2" }.
 *
 * Lives in @yiji/shared-types because the store matcher needs the very same
 * parse: it recovers the store code from a branch string to match on it (see
 * the `store_code` tier). Two copies of a four-spellings regex would drift,
 * and the failure would be silent — an unmatched store reads as a data gap,
 * not as a parser that fell behind.
 */
export { splitStoreCode };

/**
 * Map a parsed sheet onto store rows.
 *
 * Rows without a restaurant name are skipped rather than imported blank — a
 * nameless store can never match an order, so it would be invisible dead data.
 */
export function parseStoresCsv(text: string): ParseStoresResult {
  const { header, rows } = parseCsv(text);
  const skipped: ParseStoresResult['skipped'] = [];
  const unmappedHeaders: string[] = [];

  const colOf: Array<keyof ParsedStoreRow | 'ignore' | null> = header.map((h) => {
    const key = h.trim().toLowerCase();
    const mapped = HEADER_ALIASES[key];
    if (!mapped) {
      if (h.trim()) unmappedHeaders.push(h.trim());
      return null;
    }
    return mapped;
  });

  const out: ParsedStoreRow[] = [];
  rows.forEach((cells, i) => {
    const line = i + 2; // 1-based, and the header occupies line 1
    const rec: ParsedStoreRow = {
      code: null,
      name: '',
      city: null,
      areaManager: null,
      chainManager: null,
      brandCode: null,
      yijiRestaurantId: null,
    };
    colOf.forEach((key, c) => {
      if (!key || key === 'ignore') return;
      const v = (cells[c] ?? '').trim();
      if (!v) return;
      if (key === 'name') rec.name = v;
      else if (key === 'code') rec.code = v;
      else if (key === 'city') rec.city = v;
      else if (key === 'areaManager') rec.areaManager = v;
      else if (key === 'chainManager') rec.chainManager = v;
      else if (key === 'brandCode') rec.brandCode = v;
      else if (key === 'yijiRestaurantId') rec.yijiRestaurantId = v;
    });

    if (!rec.name) {
      skipped.push({ line, reason: 'no restaurant name' });
      return;
    }
    // The sheet packs the code into the name ("LCP-002 Marina Mall 2") unless a
    // separate code column supplied one.
    if (!rec.code) {
      const split = splitStoreCode(rec.name);
      rec.code = split.code;
      rec.name = split.name;
    }
    out.push(rec);
  });

  return { rows: out, skipped, unmappedHeaders };
}

/*
 * The CSV WRITER moved to @yiji/reports, where the five report pages already
 * reach for it. Two copies of a quoting-and-BOM routine is exactly the kind of
 * pair that drifts silently: the other copy on this codebase had no BOM, so its
 * files opened as mojibake in Excel for every Arabic name, and nobody found out
 * until somebody opened one.
 *
 * Re-exported rather than repointed at every call site, so the stores feature
 * keeps importing what it always imported. The PARSER above stays here — it is
 * the stores import, not a report concern.
 */
export { toCsv, downloadCsv } from '@yiji/reports';
