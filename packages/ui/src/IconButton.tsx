import type { ButtonHTMLAttributes, JSX } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';

type Size = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  variant?: 'ghost' | 'secondary' | 'outline';
  'aria-label': string;
}

const sizes: Record<Size, string> = {
  sm: 'h-7 w-7 rounded-lg',
  md: 'h-8 w-8 rounded-lg',
  lg: 'h-10 w-10 rounded-xl',
};

const variants = {
  ghost: 'bg-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
  secondary:
    'bg-secondary text-foreground ring-1 ring-foreground/[0.06] hover:ring-foreground/[0.12]',
  outline: 'bg-transparent text-foreground ring-1 ring-foreground/[0.1] hover:bg-secondary/60',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', variant = 'ghost', className, type = 'button', ...rest },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center transition-[transform,background-color,color,box-shadow] duration-fast ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:opacity-50 disabled:pointer-events-none',
        'active:enabled:scale-[0.94]',
        sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
});
