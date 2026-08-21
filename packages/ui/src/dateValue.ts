/*
 * dd/mm/yyyy ⇄ ISO conversion, kept separate from the component so the parsing
 * rules can be tested directly rather than through a rendered input.
 *
 * The product displays ONE date format (see `formatDate`), and `<input
 * type="date">` cannot be made to honour it: Chrome renders the date field from
 * the browser's own locale and ignores both `lang` on the document and `lang`
 * on the element. Verified, not assumed — an en-GB browser with `lang="en-GB"`
 * set in both places still painted `mm/dd/yyyy`. So the display format has to
 * be ours, which means parsing the typed text ourselves.
 *
 * ISO (`yyyy-mm-dd`) stays the value that crosses every boundary — props,
 * state, query strings, the API. dd/mm/yyyy exists only where a human reads or
 * types it.
 */

/** `2026-08-21` → `21/08/2026`. Empty/invalid → `''`. */
export function isoToDisplay(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * `21/08/2026` → `2026-08-21`. Returns `null` when the text is not a complete,
 * real date.
 *
 * Real, not merely well-shaped: `31/02/2026` matches the pattern and is not a
 * date. Round-tripping through `Date` and comparing the parts back is what
 * catches it — JS silently rolls February 31st forward into March.
 */
export function displayToIso(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Normalise a keystroke into dd/mm/yyyy as it is typed.
 *
 * Slashes are inserted for the user rather than required from them, because a
 * field that demands punctuation mid-number is a field people fight. Everything
 * that is not a digit is dropped — including any slashes the user did type, so
 * pasting `21/08/2026` and typing `21082026` land on the same string.
 *
 * Deleting is left alone: this only ever adds separators after a group is
 * complete, so backspacing through `21/` does not re-add the slash it just
 * removed and trap the caret.
 */
export function maskDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
