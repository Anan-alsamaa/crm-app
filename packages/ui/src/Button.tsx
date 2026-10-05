import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';
import { Spinner } from './Spinner.js';

type Variant =
  | 'default'
  | 'brand'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'success'
  | 'destructive'
  | 'destructive-soft'
  | 'link';
type Size = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
}

const base =
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none ' +
  'transition-[transform,background-color,color,border-color,box-shadow] duration-base ease-out ' +
  'disabled:opacity-50 disabled:pointer-events-none ' +
  // Confident, on-brand teal focus ring (keyboard a11y) + tactile press.
  'outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'active:enabled:scale-[0.97]';

const variants: Record<Variant, string> = {
  /**
   * Default CTA = solid display ink with a soft jade glow. The previous
   * cyan→violet gradient was the single loudest "AI default" in the product —
   * a flagship CTA states its case in one confident color and lets the
   * jade-tinted glow carry the depth (it reads as light on the dark canvas).
   */
  default:
    'bg-display text-background border border-transparent ' +
    'shadow-[0_8px_24px_-12px_oklch(var(--primary)/0.45)] hover:bg-primary-strong ' +
    'hover:shadow-[0_10px_28px_-12px_oklch(var(--primary)/0.6)]',
  /*
   * Solid brand fill for secondary brand moments.
   *
   * HOVER AND PRESS GO DARKER, NOT LIGHTER (owner, 2026-10-05: "on selection
   * should be 1 shade dark on hover and click"). This used `bg-primary/90`,
   * which drops opacity and therefore blends toward the page — on a light
   * background that reads as the button FADING when you reach for it, the
   * opposite of the feedback a press should give.
   *
   * `--primary-strong` is the same hue at lower lightness (0.4 against 0.457),
   * so it is a real shade of the brand rather than a transparency trick, and
   * the dark theme defines its own pair so the gesture survives the flip.
   * `active:` darkens once more on the press itself.
   */
  brand:
    'bg-primary text-primary-foreground border border-transparent ' +
    'shadow-[0_8px_24px_-12px_oklch(var(--primary)/0.5)] ' +
    'hover:bg-primary-strong hover:shadow-[0_10px_28px_-12px_oklch(var(--primary)/0.6)] ' +
    'active:bg-primary-strong active:shadow-[0_4px_12px_-8px_oklch(var(--primary)/0.7)]',
  secondary:
    'bg-secondary text-foreground border border-transparent ' +
    'ring-1 ring-foreground/[0.06] hover:ring-foreground/[0.12]',
  outline:
    'bg-card/40 text-foreground border-0 ring-1 ring-foreground/[0.08] hover:bg-card hover:ring-foreground/[0.14]',
  ghost: 'bg-transparent text-foreground border border-transparent hover:bg-secondary/60',
  // Positive terminal action (resolve, mark solved). Carries the same visual
  // weight and glow as the default CTA so it reads as a primary action, but in
  // a different hue so the two are never mistaken for each other.
  success:
    'bg-success text-success-foreground border border-transparent ' +
    'shadow-md shadow-success/25 hover:bg-success/90 hover:shadow-lg hover:shadow-success/35',
  destructive:
    'bg-destructive text-destructive-foreground border border-transparent ' +
    'shadow-sm shadow-destructive/30 hover:bg-destructive/90',
  /*
   * A TINTED red, for an action that ENDS something without destroying it.
   *
   * "Close this chat" is reversible — the same button reopens it — so the solid
   * `destructive` fill would overstate it, reading like Delete beside controls
   * that really are irreversible. This keeps the warning hue and drops the
   * weight (owner, 2026-09-30).
   */
  'destructive-soft':
    'bg-destructive/10 text-destructive border border-transparent ' +
    'ring-1 ring-inset ring-destructive/20 hover:bg-destructive/15 hover:ring-destructive/30',
  link: 'bg-transparent text-foreground underline-offset-4 hover:underline px-0 border border-transparent rounded-none',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-4 text-xs rounded-full',
  md: 'h-10 px-5 text-sm rounded-full',
  lg: 'h-12 px-6 text-sm rounded-full',
  icon: 'h-10 w-10 rounded-full',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'default',
    size = 'md',
    loading = false,
    disabled,
    iconStart,
    iconEnd,
    fullWidth,
    children,
    type = 'button',
    ...rest
  },
  ref,
): JSX.Element {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      data-loading={loading || undefined}
      className={cn(
        base,
        variants[variant],
        variant === 'link' ? '' : sizes[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : iconStart}
      {children && size !== 'icon' && <span>{children}</span>}
      {!loading && iconEnd}
    </button>
  );
});
