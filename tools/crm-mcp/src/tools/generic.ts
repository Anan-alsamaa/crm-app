import type { CrmClient } from '../client.js';
import { capText, redact } from '../format.js';
import { checkQuery, type QueryInput } from '../query.js';

/** `crm_query`: a checked, capped, redacted Directus items read. */
export async function genericQuery(c: CrmClient, input: QueryInput): Promise<string> {
  const q = checkQuery(input); // throws QueryRefused before any request
  const rows = await c.items(q.collection, {
    fields: q.fields,
    filter: q.filter,
    sort: q.sort,
    limit: q.limit,
  });
  const head = `${q.collection}: ${rows.length} row(s)${rows.length === q.limit ? ` (limit ${q.limit} reached)` : ''} · fields ${q.fields.join(',')}${q.sort.length ? ` · sort ${q.sort.join(',')}` : ''}`;
  return capText(`${head}\n${JSON.stringify(redact(rows), null, 1)}`);
}
