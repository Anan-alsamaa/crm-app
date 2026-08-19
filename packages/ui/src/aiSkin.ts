/**
 * The skin every AI surface wears — the product's own blue, after dark.
 *
 * The product is AURA LIGHT: mint canvas, white cards. The AI surfaces are
 * deliberately NOT that. Anything a model writes carries a risk the rest of
 * the interface does not — it can be fluent and wrong — so it gets a surface
 * nobody can mistake for the application's own chrome: dark, self-contained,
 * unmistakably a place where a machine is talking. The warm accent is the one
 * hot colour in the product and marks only what the human drives: send, and
 * the questions offered to ask.
 *
 * The hues are the PAGE's, not a borrowed palette: the panel is the primary
 * blue (hue ~262) taken down to near-black, and the accent is the sky already
 * used across the product, lifted bright enough to carry dark text. A teal
 * night with a gold accent looked well made and belonged to somewhere else —
 * the surface has to read as this application at night, not as a different
 * product embedded in it.
 *
 * Literal OKLCH rather than theme tokens on purpose. These belong to this
 * surface; promoting them to the theme would invite reuse somewhere the
 * darkness would simply look like a bug.
 */
export const AI_SKIN = {
  /** Panel ground — a diagonal fall from teal into near-black green. */
  panel:
    'bg-[linear-gradient(157deg,oklch(0.28_0.075_264)_0%,oklch(0.22_0.065_268)_46%,oklch(0.15_0.04_266)_100%)] ring-white/10',
  /** Header / footer bands: a lift off the panel, never a hard rule. */
  head: 'border-b border-white/10 bg-white/[0.04]',
  text: 'text-[oklch(0.97_0.012_262)]',
  dim: 'text-[oklch(0.75_0.03_262)]',
  accent: 'text-[oklch(0.82_0.13_212)]',
  /** The one hot fill: send buttons and the customer's own words. */
  accentBg: 'bg-[oklch(0.82_0.13_212)] text-[oklch(0.20_0.05_255)]',
  accentRing: 'ring-[oklch(0.82_0.13_212)]/40',
  /**
   * The same accent, for overriding a <Button>'s own variant.
   *
   * `cn` here is plain concatenation, NOT tailwind-merge: a variant's
   * `bg-display` and a caller's `bg-[…]` both survive into the class list and
   * the stylesheet's order decides the winner — which is how the primary
   * action stayed product-blue on a panel that had gone dark. `!` settles it
   * rather than leaving the outcome to CSS ordering.
   */
  accentBtn:
    '!bg-[oklch(0.82_0.13_212)] !text-[oklch(0.20_0.05_255)] hover:!bg-[oklch(0.87_0.13_212)] !border-transparent !shadow-none',
  /** Anything the model said. */
  bubble: 'bg-white/[0.07] ring-1 ring-white/10',
  /** Anything the human may press. */
  glass: 'bg-white/[0.05] ring-1 ring-white/10 hover:bg-white/[0.10]',
} as const;
