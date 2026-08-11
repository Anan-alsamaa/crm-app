/**
 * Mapping a Yiji order onto the operations team's own store master data.
 *
 * WHY THIS IS NOT A SIMPLE LOOKUP — the two systems share no key. Verified
 * against a real captured order (946641, 2026-08-10):
 *
 *   Yiji  restaurantName: "Riyadh - Masief Plaza"   ("<city> - <place>")
 *   Yiji  brandName:      " La Casa Pasta"          (note the LEADING SPACE)
 *   Sheet restaurant:     "LCP-002 Marina Mall 2"   ("<brandcode>-<nnn> <place>")
 *   Sheet brand:          "LCP"                     (a CODE, not the full name)
 *
 * So: Yiji embeds the city in the branch name and spells the brand out in full;
 * the ops sheet prefixes a store code and abbreviates the brand. Nothing lines
 * up on a raw string compare, and the upstream data is not even trimmed.
 *
 * The order payload DOES carry `restaurantId`, which would be a proper key —
 * but it is only on the single-order endpoint, and `orderToSnapshot()` has
 * never persisted it, so historical tickets cannot be joined by id at all.
 * Hence: match on id when we have been given one, else fall back to a
 * normalised name compare, and make an unmatched store VISIBLE rather than
 * silently blank (an empty city reads as "no data", not "fix your mapping").
 */

/** One row of the operations team's store master data. */
export interface StoreRecord {
  id: string;
  /** Store code, e.g. "LCP-002". */
  code: string | null;
  /** Branch name without the code, e.g. "Marina Mall 2". */
  name: string;
  city: string | null;
  areaManager: string | null;
  chainManager: string | null;
  /** Brand code, e.g. "LCP". */
  brandCode: string | null;
  /** Brand display name as operations call it, e.g. "Casa Pasta". */
  brandName: string | null;
  /**
   * What the ORDER SYSTEM calls this brand, when that differs from the display
   * name — Yiji says "La Casa Pasta" where operations say "Casa Pasta". Without
   * indexing this alias, renaming a brand to the operations wording silently
   * breaks the brand-only fallback: the store-level match still works, so the
   * failure only shows up for branches that are missing from the store list,
   * which is exactly when the fallback was supposed to save you.
   */
  brandYijiName?: string | null;
  /**
   * Yiji's own restaurant id, when operations have been able to supply it.
   * Optional by necessity — the sheets do not carry it today. When present it
   * wins over every name heuristic below.
   */
  yijiRestaurantId: string | null;
}

/** What a ticket's order tells us about where the order was placed. */
export interface OrderRestaurantRef {
  restaurantId?: string | null;
  restaurantName?: string | null;
  brandName?: string | null;
}

export interface StoreMatch {
  store: StoreRecord | null;
  /** How the row was matched — surfaced in the UI so gaps are diagnosable. */
  via: 'yiji_id' | 'exact_name' | 'normalised_name' | 'store_code' | 'brand_only' | 'none';
  /** Brand name to display, from the store when matched, else from the order. */
  brandName: string;
  city: string;
  areaManager: string;
  chainManager: string;
  /** Branch name to display. Prefers the ops sheet's wording once matched. */
  restaurantName: string;
}

const STORE_CODE_PREFIX = /^[A-Za-z]{2,6}[-\s]?\d{1,4}\s+/;

/**
 * The operations master spells the same store code four ways, so anything that
 * wants the code out of a branch string has to understand all four:
 *
 *   LCP-032 Masief Plaza    dash
 *   LCP- 089 Nada Plaza     dash + space
 *   LCP058-ARAMCO           no separator, dash AFTER the number
 *   LCP.073 - Amer Mall     dot, then a dash separating the name
 */
const STORE_CODE_ANY = /^([A-Za-z]{2,6})[\s.\-_]*(\d{1,4})\s*[-–]?\s*(.*)$/;

/**
 * "LCP-002 Marina Mall 2" → { code: "LCP-002", name: "Marina Mall 2" }.
 *
 * Normalise all four spellings above to `PREFIX-NNN`, and drop the leading dash
 * from what is left so the name does not come out as "- Amer Mall". A string
 * with no trailing name ("LCP-002") is NOT treated as a code, because then
 * every bare branch name would parse as one.
 */
export function splitStoreCode(raw: string | null | undefined): {
  code: string | null;
  name: string;
} {
  const s = String(raw ?? '').trim();
  const m = STORE_CODE_ANY.exec(s);
  if (m && m[3]?.trim()) return { code: `${m[1]!.toUpperCase()}-${m[2]}`, name: m[3].trim() };
  return { code: null, name: s };
}

/** Canonical `PREFIX-NNN` store code embedded in a branch string, if any. */
export function storeCodeFrom(raw: string | null | undefined): string {
  return splitStoreCode(raw).code ?? '';
}

/**
 * Collapse a restaurant name to something comparable across the two systems.
 *
 * Order matters: strip the ops store code first, then the "<city> - " prefix
 * Yiji puts in front of the branch, because a code like "LCP-002" contains the
 * hyphen the city split would otherwise trip on.
 */
export function normaliseRestaurantName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).trim();
  s = s.replace(STORE_CODE_PREFIX, '');
  // "Riyadh - Masief Plaza" → "Masief Plaza". Only when the separator is a
  // spaced hyphen, so hyphenated place names ("Al-Nakheel") survive intact.
  const citySplit = s.split(/\s+-\s+/);
  if (citySplit.length > 1) s = citySplit.slice(1).join(' - ');
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Brand names compare on a looser key — Yiji ships them untrimmed. */
export function normaliseBrandName(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The city Yiji embedded in "<city> - <place>", when it did. */
export function cityFromRestaurantName(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim().replace(STORE_CODE_PREFIX, '');
  const parts = s.split(/\s+-\s+/);
  return parts.length > 1 ? parts[0]!.trim() : '';
}

/** Precomputed lookup so a report over N tickets stays O(N), not O(N*stores). */
export interface StoreIndex {
  byYijiId: Map<string, StoreRecord>;
  byExactName: Map<string, StoreRecord>;
  byNormalisedName: Map<string, StoreRecord>;
  /**
   * Store code → store, and ONLY for codes that identify exactly one store.
   * Unlike the name maps this is not first-writer-wins: a code is supposed to
   * be the master's primary key, so a duplicated one means the master is
   * broken. Guessing between the two would attribute complaints to whichever
   * row happened to load first, so a duplicated code resolves to nothing and
   * the row falls through to the brand fallback / NOT_MAPPED instead.
   */
  byCode: Map<string, StoreRecord>;
  byBrand: Map<string, StoreRecord>;
}

export function buildStoreIndex(stores: readonly StoreRecord[]): StoreIndex {
  const byYijiId = new Map<string, StoreRecord>();
  const byExactName = new Map<string, StoreRecord>();
  const byNormalisedName = new Map<string, StoreRecord>();
  const byCode = new Map<string, StoreRecord>();
  const duplicateCodes = new Set<string>();
  const byBrand = new Map<string, StoreRecord>();
  for (const s of stores) {
    const code = (s.code ?? '').trim().toUpperCase();
    if (code) {
      if (byCode.has(code) && byCode.get(code) !== s) duplicateCodes.add(code);
      else byCode.set(code, s);
    }
    if (s.yijiRestaurantId) byYijiId.set(String(s.yijiRestaurantId).trim(), s);
    const full = [s.code, s.name].filter(Boolean).join(' ').trim();
    // First writer wins, so an earlier row is never silently replaced by a
    // later duplicate — duplicates are a data problem to surface, not to hide.
    if (full && !byExactName.has(full.toLowerCase())) byExactName.set(full.toLowerCase(), s);
    if (s.name && !byExactName.has(s.name.trim().toLowerCase()))
      byExactName.set(s.name.trim().toLowerCase(), s);
    const norm = normaliseRestaurantName(s.name);
    if (norm && !byNormalisedName.has(norm)) byNormalisedName.set(norm, s);
    // Index the brand under BOTH what operations call it and what the order
    // system sends, so a rename in one system cannot orphan the other.
    for (const alias of [s.brandName, s.brandYijiName]) {
      const brandKey = normaliseBrandName(alias);
      if (brandKey && !byBrand.has(brandKey)) byBrand.set(brandKey, s);
    }
  }
  for (const code of duplicateCodes) byCode.delete(code);
  return { byYijiId, byExactName, byNormalisedName, byCode, byBrand };
}

/** Label used wherever a store could not be resolved. */
export const NOT_MAPPED = 'Not mapped';

export function matchStore(index: StoreIndex, order: OrderRestaurantRef | null): StoreMatch {
  const orderBrand = (order?.brandName ?? '').trim();
  const orderName = (order?.restaurantName ?? '').trim();

  const unmatched = (via: StoreMatch['via']): StoreMatch => ({
    store: null,
    via,
    // Keep whatever the order DID tell us — losing the real restaurant name
    // would make the report worse than before the mapping existed.
    brandName: orderBrand,
    city: cityFromRestaurantName(orderName),
    areaManager: '',
    chainManager: '',
    restaurantName: orderName,
  });

  if (!order || (!orderName && !order.restaurantId)) return unmatched('none');

  const resolved = (store: StoreRecord, via: StoreMatch['via']): StoreMatch => ({
    store,
    via,
    brandName: store.brandName || store.brandCode || orderBrand,
    city: store.city || cityFromRestaurantName(orderName),
    areaManager: store.areaManager ?? '',
    chainManager: store.chainManager ?? '',
    restaurantName: [store.code, store.name].filter(Boolean).join(' ') || orderName,
  });

  const id = order.restaurantId != null ? String(order.restaurantId).trim() : '';
  if (id) {
    const hit = index.byYijiId.get(id);
    if (hit) return resolved(hit, 'yiji_id');
  }

  if (orderName) {
    const exact = index.byExactName.get(orderName.toLowerCase());
    if (exact) return resolved(exact, 'exact_name');

    const norm = normaliseRestaurantName(orderName);
    if (norm) {
      const hit = index.byNormalisedName.get(norm);
      if (hit) return resolved(hit, 'normalised_name');
    }
  }

  // Neither name tier fired. If the branch string carries an ops store code,
  // that code IS the master's key and beats any further name guessing — the
  // names drift in ways the codes do not. Real case: the complaints history
  // says "LCP-006 Panorama Mall" where the master says "LCP-006 Panorama Mall
  // RYD", so both name tiers miss on a city suffix while the code is exact.
  //
  // Deliberately placed AFTER the name tiers, not before: every row that
  // matches today keeps matching the same way, so this can only rescue rows
  // that were about to be reported as unmapped.
  const code = storeCodeFrom(orderName);
  if (code) {
    const hit = index.byCode.get(code);
    if (hit) return resolved(hit, 'store_code');
  }

  // Nothing matched the branch. The BRAND may still be known, which is enough
  // for the brand-level dashboard even when the individual store is missing.
  const brandKey = normaliseBrandName(orderBrand);
  if (brandKey) {
    const brandHit = index.byBrand.get(brandKey);
    if (brandHit) {
      return {
        store: null,
        via: 'brand_only',
        brandName: brandHit.brandName || orderBrand,
        city: cityFromRestaurantName(orderName),
        areaManager: '',
        chainManager: '',
        restaurantName: orderName,
      };
    }
  }

  return unmatched('none');
}

/** True when the store itself could not be resolved (brand-only still counts). */
export function isUnmappedStore(m: StoreMatch): boolean {
  return m.store === null;
}
