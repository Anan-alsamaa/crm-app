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
  sm: 'h-7 w-7 rounded-md',
  md: 'h-8 w-8 rounded-md',
  lg: 'h-10 w-10 rounded-md',
};

const variants = {
  ghost: 'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
  secondary: 'bg-secondary text-foreground hover:bg-secondary/70',
  outline: 'bg-transparent text-foreground border border-border-strong hover:bg-secondary',
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
        'inline-flex items-center justify-center transition-[transform,background-color,color] duration-fast ease-out',
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
