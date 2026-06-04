import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns whether it currently matches and
 * updates on change. SSR-safe: returns `false` when `window.matchMedia` is
 * unavailable (the portals are client-only SPAs, so the first client paint
 * reads the real value synchronously — no layout flash).
 */
export function useMediaQuery(query: string): boolean {
  const read = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;

  const [matches, setMatches] = useState<boolean>(read);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind `lg` breakpoint (1024px). True on desktop-width viewports. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
