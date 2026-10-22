/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@yiji/ui/tailwind-preset')],
  /*
   * EVERY SOURCE THAT WRITES A CLASS NAME, or Tailwind purges the class.
   *
   * `packages/order-views` is listed because the order card both portals render
   * now lives there (ops, 2026-10-04). Tailwind only emits a utility it has SEEN
   * in a scanned file: a component moved out of `./src` without its glob
   * following it compiles, typechecks and ships with no styling at all — a
   * stack of unstyled text where the cart used to be. Nothing in the toolchain
   * reports it, which puts it squarely in this codebase's silent-empty-failure
   * family.
   */
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
    '../../packages/order-views/src/**/*.{ts,tsx}',
  ],
  /*
   * THE ADMIN SKIN (owner, 2026-10-22: the "Rapport" reference, in our colours).
   *
   * Everything here is ADMIN-ONLY by construction: this config compiles the
   * admin bundle and nothing else, so the shared `@yiji/ui` primitives pick up
   * these fonts, radii and shadows when they render HERE, while the agent
   * portal - compiled from its own config off the same preset - is untouched.
   * Rolling the skin back is deleting this block (and the skin section of
   * src/index.css).
   */
  theme: {
    extend: {
      fontFamily: {
        /* Urbanist sets the whole console. Self-hosted (fontsource), not a
           Google Fonts link: the portals ship a CSP of `font-src 'self'`, so a
           third-party font would be blocked in production and silently fall
           back. Arabic glyphs are not in Urbanist; the browser falls through to
           the Arabic faces per glyph. */
        sans: [
          '"Urbanist Variable"',
          '"Noto Sans Arabic"',
          'Tahoma',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          '"Segoe UI"',
          'Roboto',
          'Arial',
          'sans-serif',
        ],
        display: [
          '"Urbanist Variable"',
          '"Noto Sans Arabic"',
          'Tahoma',
          'ui-sans-serif',
          'sans-serif',
        ],
      },
      /* Urbanist has a small x-height, so the reference sets it a half-step
         larger than a grotesque would be: 14px body, 13.5px controls, 12.5px
         secondary. Same token names, so every page moves with it. */
      fontSize: {
        '2xs': ['0.71875rem', { lineHeight: '1rem' }],
        xs: ['0.78125rem', { lineHeight: '1.15rem' }],
        sm: ['0.84375rem', { lineHeight: '1.3rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
      },
      boxShadow: {
        /* The frosted card: a lit top edge and one long, soft drop. */
        soft: 'inset 0 1px 0 rgb(255 255 255 / 0.7), 0 1px 2px oklch(var(--shadow-color) / 0.05), 0 24px 48px -30px oklch(var(--shadow-color) / 0.32)',
        float:
          'inset 0 1px 0 rgb(255 255 255 / 0.7), 0 2px 6px oklch(var(--shadow-color) / 0.06), 0 30px 60px -32px oklch(var(--shadow-color) / 0.4)',
      },
    },
  },
};
