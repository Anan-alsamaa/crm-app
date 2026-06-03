/**
 * Tiny className joiner. Keeps deps zero. Filters out falsy entries so callers
 * can write `cn('base', cond && 'extra')` without ternary noise.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}
