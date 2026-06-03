import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { readItems, createItem, readFile } from '@directus/sdk';
import type { ImportJob } from '@yiji/shared-types';
import type { YijiDirectusClient } from '@yiji/shared-config';

/**
 * Imports processor.
 *
 * Streams a CSV (uploaded to Directus files) row by row, maps columns per
 * the admin-supplied `mapping` (csvHeader → contactField), and upserts each
 * contact with per-vendor dedup keyed on phone OR email. Records a per-row
 * result so the admin UI can show a summary.
 *
 * Memory profile: parses the file as a single string here. For very large
 * imports we'd switch to a streaming parser; for the spec target (low
 * thousands of rows) this is plenty.
 */

export interface ImportsDeps {
  directus: YijiDirectusClient;
  /** Base URL of Directus, needed to download the file blob. */
  directusUrl: string;
  /** Service-account static token (passed in Authorization header). */
  directusToken: string;
  logger: Logger;
}

export interface ImportRowResult {
  row: number;
  action: 'created' | 'duplicate' | 'skipped';
  reason?: string;
  contactId?: string;
}

export interface ImportSummary {
  total: number;
  created: number;
  duplicates: number;
  skipped: number;
  results: ImportRowResult[];
}

/**
 * Minimal RFC 4180 CSV parser. Handles quoted fields with embedded commas,
 * doubled quotes, CRLF / LF line endings. No streaming — caller passes the
 * full text.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Strip trailing all-empty row (common after a final newline).
  if (rows.length > 0 && rows[rows.length - 1]?.every((v) => v === '')) {
    rows.pop();
  }
  return rows;
}

interface IncomingContact {
  external_customer_id?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** Per-vendor dedup: returns the existing contact id when a match is found. */
export async function findExistingContact(
  directus: YijiDirectusClient,
  vendorId: string,
  candidate: IncomingContact,
): Promise<string | null> {
  if (!candidate.phone && !candidate.email) return null;
  const orFilters: Array<Record<string, unknown>> = [];
  if (candidate.phone) orFilters.push({ phone: { _eq: candidate.phone } });
  if (candidate.email) orFilters.push({ email: { _eq: candidate.email } });
  const matches = (await directus.request(
    readItems('contacts', {
      filter: { vendor: { _eq: vendorId }, _or: orFilters } as never,
      fields: ['id'],
      limit: 1,
    }),
  )) as Array<{ id: string }>;
  return matches[0]?.id ?? null;
}

export async function processImportJob(
  job: Job<ImportJob>,
  deps: ImportsDeps,
): Promise<ImportSummary> {
  const { fileId, vendorId, mapping } = job.data;
  const { directus, logger } = deps;

  // Discover the file's storage url, then fetch via the asset endpoint.
  // The /assets/<id> endpoint requires the bearer token to download the blob.
  await directus.request(readFile(fileId, { fields: ['id', 'filename_disk', 'filename_download'] }));
  const res = await fetch(`${deps.directusUrl}/assets/${fileId}`, {
    headers: { authorization: `Bearer ${deps.directusToken}` },
  });
  if (!res.ok) throw new Error(`failed to fetch import file ${fileId} (${res.status})`);
  const text = await res.text();

  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { total: 0, created: 0, duplicates: 0, skipped: 0, results: [] };
  }

  const header = rows[0]!;
  // mapping is csvHeader → contactField. Reverse: contactField → csvIndex.
  const fieldToIndex: Record<string, number> = {};
  for (const [csvHeader, contactField] of Object.entries(mapping)) {
    const idx = header.indexOf(csvHeader);
    if (idx >= 0) fieldToIndex[contactField] = idx;
  }

  const results: ImportRowResult[] = [];
  let created = 0;
  let duplicates = 0;
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const candidate: IncomingContact = {
      external_customer_id: cells[fieldToIndex.external_customer_id ?? -1] ?? null,
      name: cells[fieldToIndex.name ?? -1] ?? null,
      phone: cells[fieldToIndex.phone ?? -1] ?? null,
      email: cells[fieldToIndex.email ?? -1] ?? null,
    };

    if (!candidate.phone && !candidate.email && !candidate.external_customer_id) {
      skipped++;
      results.push({ row: r, action: 'skipped', reason: 'no identifier' });
      continue;
    }

    try {
      const existingId = await findExistingContact(directus, vendorId, candidate);
      if (existingId) {
        duplicates++;
        results.push({ row: r, action: 'duplicate', contactId: existingId });
        continue;
      }
      const inserted = (await directus.request(
        createItem('contacts', { ...candidate, vendor: vendorId } as never),
      )) as { id: string } | undefined;
      created++;
      results.push({ row: r, action: 'created', contactId: inserted?.id });
    } catch (err) {
      skipped++;
      results.push({ row: r, action: 'skipped', reason: (err as Error).message });
    }
  }

  const summary: ImportSummary = {
    total: rows.length - 1, // exclude header
    created,
    duplicates,
    skipped,
    results,
  };
  logger.info(
    { vendorId, fileId, total: summary.total, created, duplicates, skipped },
    'imports job complete',
  );
  return summary;
}
