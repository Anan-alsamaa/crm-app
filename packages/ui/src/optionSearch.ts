import { isValidElement, type ReactNode } from 'react';

/*
 * TYPE-TO-FILTER for every dropdown (owner, 2026-10-26: "the dropdown should be
 * like an input field, where typing in it displays the related options").
 *
 * Shared by `SelectMenu` and `MultiSelectMenu` so the two menus agree on what
 * "matches" means:
 *
 *   - ANYWHERE in the label, not just the start: the memorable part of
 *     "LCP-053 Othaim Mall Khurais Road" sits in the middle.
 *   - Case-insensitive, and Latin accents ignored ("cafe" finds "Café").
 *   - Arabic is matched on its letters, not its spelling variants: harakat
 *     (tashkeel) and the tatweel are dropped, the alef forms (أ إ آ ٱ) fold to
 *     ا, ى folds to ي and ة to ه. An agent typing "احمد" finds "أحمد", and
 *     "مطعم" finds "مطـعم".
 */

/** Text an option can be searched by — the label's own words, recursively. */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

/** Lower-case, accent-free, Arabic-normalised form used for matching. */
export function normalizeSearchText(text: string): string {
  return (
    text
      .normalize('NFKD')
      // Latin combining accents.
      .replace(/[̀-ͯ]/g, '')
      // Arabic harakat, Quranic marks and the superscript alef.
      .replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '')
      // Tatweel (kashida) is decoration, never a letter.
      .replace(/ـ/g, '')
      .replace(/[آأإٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** True when `query` (already typed by the user) occurs anywhere in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const q = normalizeSearchText(query);
  if (!q) return true;
  return normalizeSearchText(text).includes(q);
}

/** The UI's language, read from the document the portals set (`<html lang>`). */
function isArabicUi(): boolean {
  if (typeof document === 'undefined') return false;
  return (document.documentElement.lang || '').toLowerCase().startsWith('ar');
}

/**
 * Built-in wording for the search box. The ui package has no i18n of its own,
 * and both portals set `<html lang>` on every language switch, so reading it
 * here localises every dropdown without threading props through ~100 call
 * sites. A caller can still override each string.
 */
export function searchStrings(): { placeholder: string; label: string; empty: string } {
  return isArabicUi()
    ? { placeholder: 'اكتب للبحث…', label: 'ابحث في الخيارات', empty: 'لا توجد نتائج مطابقة' }
    : { placeholder: 'Search…', label: 'Search options', empty: 'No matches' };
}
