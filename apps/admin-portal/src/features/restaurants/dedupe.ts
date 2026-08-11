import { splitStoreCode } from './csv.js';

/**
 * Identity rules that make the Restaurants import repeatable.
 *
 * The import used to call `createItems` blindly, so re-uploading the same
 * 134-row master inserted 134 duplicates — and a duplicated store silently
 * splits one branch's complaints across two rows in every later report.
 *
 * The rule here is deliberately one-directional: a row we already have is
 * SKIPPED, never updated and never deleted. An import must not be able to
 * overwrite a correction someone made by hand in the UI; a re-upload of a
 * stale sheet would otherwise quietly revert it.
 */

/**
 * `LCP058` / `lcp 058` / `LCP.058` → `LCP-058`.
 *
 * The operations master spells the same code four ways (see `splitStoreCode`),
 * and rows created through the form can carry any of them, so both sides of a
 * comparison have to be folded to one spelling first. Digits are NOT
 * zero-stripped: `LCP-006` and `LCP-6` are different codes in this master.
 */
export function normaliseStoreCode(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = /^([A-Za-z]{2,6})[\s._-]*(\d{1,4})$/.exec(s);
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : s.toUpperCase();
}

/** Case/spacing/punctuation-insensitive form of a name, for comparison only. */
export function foldName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The code and name a row really has, given that the master sometimes packs
 * the code INTO the name ("LCP-006 Panorama Mall") and leaves the code column
 * empty. Without this, the same branch keys differently depending on which of
 * the two shapes it happened to be entered in, and the import inserts it twice.
 */
export function effectiveIdentity(row: { code?: string | null; name?: string | null }): {
  code: string;
  name: string;
} {
  const direct = normaliseStoreCode(row.code);
  if (direct) return { code: direct, name: String(row.name ?? '').trim() };
  const split = splitStoreCode(String(row.name ?? ''));
  return { code: normaliseStoreCode(split.code), name: split.name };
}

/**
 * Identity of a store row.
 *
 * Prefers the store code, which is the master's real key and already carries
 * the brand ("LCP-006"). Only when there is no code at all does it fall back
 * to the name — and that fallback is scoped by brand on purpose: this master
 * has 19 branch names shared across brands ("Buhairah Plaza" exists for three
 * of them), so an unscoped name match would skip a genuinely new branch as
 * "already present" and lose it from every report.
 */
export function storeKey(row: {
  code?: string | null;
  name?: string | null;
  brandCode?: string | null;
}): string {
  const { code, name } = effectiveIdentity(row);
  if (code) return `code:${code}`;
  const brand = String(row.brandCode ?? '')
    .trim()
    .toUpperCase();
  return `name:${brand || '-'}:${foldName(name)}`;
}

/** Identity of a brand row — code first, name only when there is no code. */
export function brandKey(row: { code?: string | null; name?: string | null }): string {
  const code = String(row.code ?? '').trim();
  if (code) return `code:${code.toUpperCase()}`;
  return `name:${foldName(row.name)}`;
}

export interface Partitioned<T> {
  /** Rows to insert, in input order, with in-file repeats collapsed. */
  fresh: T[];
  /** How many input rows were dropped because the row already exists. */
  alreadyPresent: number;
}

/**
 * Split incoming rows into "insert these" and "already have these".
 *
 * Also collapses repeats WITHIN the uploaded file: a sheet that lists the same
 * branch twice must not insert it twice, or the very first import is already
 * not repeatable.
 */
export function partitionNew<T>(
  incoming: readonly T[],
  existingKeys: Iterable<string>,
  keyOf: (row: T) => string,
): Partitioned<T> {
  const seen = new Set(existingKeys);
  const fresh: T[] = [];
  let alreadyPresent = 0;
  for (const row of incoming) {
    const key = keyOf(row);
    if (seen.has(key)) {
      alreadyPresent += 1;
      continue;
    }
    seen.add(key);
    fresh.push(row);
  }
  return { fresh, alreadyPresent };
}
