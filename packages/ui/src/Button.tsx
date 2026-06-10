import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';
import { Spinner } from './Spinner.js';

type Variant = 'default' | 'brand' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
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
  // Default CTA = near-black pill with a soft drop shadow for depth.
  default:
    'bg-foreground text-background border border-transparent ' +
    'shadow-sm shadow-foreground/20 hover:bg-foreground/90 hover:shadow-md hover:shadow-foreground/25',
  // Use `brand` only when the button itself IS the brand moment (rare in app UI).
  brand:
    'bg-primary text-primary-foreground border border-transparent ' +
    'shadow-sm shadow-primary/30 hover:bg-primary/90 hover:shadow-md hover:shadow-primary/40',
  secondary:
    'bg-secondary/70 text-foreground border border-transparent ' +
    'ring-1 ring-foreground/[0.05] hover:bg-secondary',
  outline:
    'bg-card/40 text-foreground border-0 ring-1 ring-foreground/[0.08] hover:bg-card hover:ring-foreground/[0.14]',
  ghost: 'bg-transparent text-foreground border border-transparent hover:bg-secondary/60',
  destructive:
    'bg-destructive text-destructive-foreground border border-transparent ' +
    'shadow-sm shadow-destructive/30 hover:bg-destructive/90',
  link: 'bg-transparent text-foreground underline-offset-4 hover:underline px-0 border border-transparent rounded-none',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs rounded-lg',
  md: 'h-9 px-4 text-sm rounded-xl',
  lg: 'h-10 px-5 text-sm rounded-xl',
  icon: 'h-9 w-9 rounded-xl',
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
