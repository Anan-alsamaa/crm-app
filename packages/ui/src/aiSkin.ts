/**
 * The skin every AI surface wears — a deep teal night against a light product.
 *
 * The product is AURA LIGHT: mint canvas, white cards. The AI surfaces are
 * deliberately NOT that. Anything a model writes carries a risk the rest of
 * the interface does not — it can be fluent and wrong — so it gets a surface
 * nobody can mistake for the application's own chrome: dark, self-contained,
 * unmistakably a place where a machine is talking. The warm accent is the one
 * hot colour in the product and marks only what the human drives: send, and
 * the questions offered to ask.
 *
 * Literal OKLCH rather than theme tokens on purpose. These belong to this
 * surface; promoting them to the theme would invite reuse somewhere the
 * darkness would simply look like a bug.
 */
export const AI_SKIN = {
  /** Panel ground — a diagonal fall from teal into near-black green. */
  panel:
    'bg-[linear-gradient(157deg,oklch(0.27_0.048_178)_0%,oklch(0.23_0.05_170)_42%,oklch(0.16_0.032_182)_100%)] ring-white/10',
  /** Header / footer bands: a lift off the panel, never a hard rule. */
  head: 'border-b border-white/10 bg-white/[0.04]',
  text: 'text-[oklch(0.96_0.012_170)]',
  dim: 'text-[oklch(0.74_0.02_170)]',
  accent: 'text-[oklch(0.84_0.13_82)]',
  /** The one hot fill: send buttons and the customer's own words. */
  accentBg: 'bg-[oklch(0.84_0.13_82)] text-[oklch(0.22_0.05_120)]',
  accentRing: 'ring-[oklch(0.84_0.13_82)]/40',
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
    '!bg-[oklch(0.84_0.13_82)] !text-[oklch(0.22_0.05_120)] hover:!bg-[oklch(0.80_0.13_82)] !border-transparent !shadow-none',
  /** Anything the model said. */
  bubble: 'bg-white/[0.07] ring-1 ring-white/10',
  /** Anything the human may press. */
  glass: 'bg-white/[0.05] ring-1 ring-white/10 hover:bg-white/[0.10]',
} as const;
