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
};
