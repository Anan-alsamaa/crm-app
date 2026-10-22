/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@yiji/ui/tailwind-preset')],
  /*
   * EVERY SOURCE THAT WRITES A CLASS NAME, or Tailwind purges the class.
   *
   * `packages/order-views` is listed because the order card this portal used to
   * define in `features/commerce/OrderViews.tsx` now lives there, shared with
   * the admin portal (ops, 2026-10-04). Tailwind only emits a utility it has
   * SEEN in a scanned file: moving a component out of `./src` without its glob
   * following it compiles, typechecks and ships with no styling at all — a
   * stack of unstyled text where the order card used to be. Nothing in the
   * toolchain reports it, which puts it squarely in this codebase's
   * silent-empty-failure family.
   */
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
    '../../packages/order-views/src/**/*.{ts,tsx}',
  ],
  /*
   * THE AGENT SKIN (owner, 2026-10-22): the admin console's "Rapport" look,
   * carried to the agent portal so the two read as one product. The same
   * fonts, type steps, glass token and frosted shadows as the admin config;
   * this config compiles the agent bundle only, so nothing here can reach the
   * admin console. Rolling it back is deleting this block (and the skin
   * section of src/index.css).
   */
  theme: {
    extend: {
      fontFamily: {
        /* Urbanist, self-hosted (fontsource): the portals ship a CSP of
           `font-src 'self'`. Arabic falls through per glyph. */
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
      /* Urbanist has a small x-height, so it is set a half-step larger than a
         grotesque would be. Same token names, so every page moves with it. */
      fontSize: {
        '2xs': ['0.71875rem', { lineHeight: '1rem' }],
        xs: ['0.78125rem', { lineHeight: '1.15rem' }],
        sm: ['0.84375rem', { lineHeight: '1.3rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
      },
      colors: {
        /* White in light, a lifted charcoal in dark - the frosted controls. */
        glass: 'oklch(var(--glass) / <alpha-value>)',
        /* The internal-note amber: a note is the team talking, so it must
           never be mistaken for a reply the customer can read. */
        note: {
          DEFAULT: 'oklch(var(--note) / <alpha-value>)',
          tint: 'oklch(var(--note-tint) / <alpha-value>)',
          foreground: 'oklch(var(--note-foreground) / <alpha-value>)',
        },
      },
      boxShadow: {
        soft: 'var(--agent-shadow-soft)',
        float: 'var(--agent-shadow-float)',
      },
    },
  },
};
