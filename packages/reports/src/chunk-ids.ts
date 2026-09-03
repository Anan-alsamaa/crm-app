/**
 * Splitting a large id set across several `_in` queries.
 *
 * A Directus filter travels in the QUERY STRING. `{conversation: {_in: [...]}}`
 * with 232 uuids is a ~9KB filter that URL-encodes to ~27KB, and CloudFront
 * rejects anything past roughly 8KB with a bare **HTTP 414** — before the
 * request reaches Directus, so nothing appears in any service log. The calling
 * page just fails whole.
 *
 * The trap is that this bug GROWS INTO existence. It cannot reproduce on a dev
 * database with a handful of conversations; it appears the day real traffic
 * pushes the row count past the limit, on whichever page reads the most ids.
 * That is why it is worth a shared helper rather than a fix at each call site:
 * every unbounded `_in` in a browser is the same latent bug.
 *
 * Pure — the caller supplies the transport, so this stays testable and free of
 * any Directus dependency.
 */

/**
 * Ids per request. 120 uuids ≈ 4.6KB once encoded, which leaves room for
 * fields, sort and the rest of the query on every path we serve.
 */
export const IN_FILTER_CHUNK = 120;

/** Split `ids` into runs of at most {@link IN_FILTER_CHUNK}. */
export function chunkIds(ids: readonly string[], size: number = IN_FILTER_CHUNK): string[][] {
  if (size < 1) throw new RangeError('chunk size must be at least 1');
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Run `read` once per chunk and concatenate the rows.
 *
 * Sequential by design: these are a report's supporting queries, and trading a
 * visible second for a burst of parallel load on a shared API is a bad deal.
 */
export async function readChunked<T>(
  ids: readonly string[],
  read: (idChunk: string[]) => Promise<T[]>,
  size: number = IN_FILTER_CHUNK,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (const chunk of chunkIds(ids, size)) out.push(...(await read(chunk)));
  return out;
}
