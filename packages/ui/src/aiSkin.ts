/**
 * The skin every AI surface wears.
 *
 * PREVIOUSLY THIS WAS DARK, on the argument that anything a model writes should
 * sit on a surface nobody mistakes for the app's own chrome — it can be fluent
 * and wrong. The argument was reasonable; the result was not. A near-black
 * panel with a cyan accent, dropped into a light indigo product, read as a
 * different application embedded in this one — and it still carried the cyan
 * from a brand the product no longer uses.
 *
 * So identity now comes from the BRAND rather than from darkness: an indigo
 * header band, indigo accents, and the same white cards and hairline rings the
 * rest of the product is built from. The panel is recognisably Aura because of
 * its colour and its masthead, not because the lights are off.
 *
 * What replaced the "this is a machine" signal is more useful than a dark
 * background anyway: the assistant's words sit in a bubble that is visibly a
 * quotation — a card on a tinted ground — and the footer says plainly that
 * Aura can be wrong.
 *
 * Header keys are SEPARATE from body keys (`headText` vs `text`). They were one
 * set while everything was dark and every surface wanted the same near-white
 * ink; with an indigo band over a light body they need opposite values, and
 * sharing them is what would put white text on a white panel.
 *
 * Values lean on theme tokens rather than literals wherever one exists, so the
 * panel follows the brand automatically the next time `--primary` moves.
 */
export const AI_SKIN = {
  /**
   * Drawer panel — a soft indigo ground, NOT `--canvas`.
   *
   * Canvas sits at L 0.972 and a white bubble at L 1.0, which is under 3%
   * apart: the cards dissolved into the panel and the transcript read as loose
   * text. Tinting the ground toward the brand buys the separation that makes a
   * bubble look like a bubble, and ties the body to the header band.
   */
  panel: 'bg-[oklch(0.966_0.016_277)] ring-foreground/[0.08]',

  /** Header band — the one saturated surface, and the panel's whole identity. */
  head: 'bg-[linear-gradient(135deg,oklch(var(--primary))_0%,oklch(var(--violet))_100%)]',
  /** Ink ON the header band. White, because the band is always saturated. */
  headText: 'text-white',
  headDim: 'text-white/70',
  headHover: 'hover:bg-white/20',
  /** The mark chip in the header — a lift off the band, never a hard outline. */
  headChip: 'bg-white/20 ring-1 ring-white/30 text-white',

  /** Ink on the light body. */
  text: 'text-foreground',
  dim: 'text-muted-foreground',
  accent: 'text-primary',

  accentBg: 'bg-primary text-primary-foreground',
  accentRing: 'ring-primary/30',
  /**
   * The brand fill, for overriding a <Button>'s own variant.
   *
   * `cn` here is plain concatenation, NOT tailwind-merge: a variant's own
   * background and a caller's both survive into the class list and the
   * stylesheet's order decides the winner. `!` settles it rather than leaving
   * the outcome to CSS ordering.
   */
  accentBtn:
    '!bg-primary !text-primary-foreground hover:!bg-primary-strong !border-transparent !shadow-none',

  /** Anything the model said — a white card, quoted onto the tinted ground. */
  bubble: 'bg-card ring-1 ring-foreground/[0.07] shadow-soft',
  /** Anything the HUMAN said — the brand fill, so a glance reads the pattern. */
  userBubble: 'bg-primary text-primary-foreground shadow-soft',
  /** Anything the human may press — lifts toward the brand on hover. */
  glass:
    'bg-card ring-1 ring-foreground/[0.09] shadow-soft hover:bg-primary-tint/60 hover:ring-primary/40 transition-colors duration-fast ease-out',
  /** The composer field. */
  field:
    'bg-card ring-1 ring-inset ring-foreground/[0.1] text-foreground placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-primary/50',
  /** Hairline between the body and the composer. */
  rule: 'border-foreground/[0.08]',
} as const;
