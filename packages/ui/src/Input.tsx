import type { InputHTMLAttributes, JSX, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/*
 * Field base — fill + visible border + real focus ring. Per impeccable critique
 * P0: bare 1px hairline inputs on white read as raw HTML. The subtle muted
 * fill plus the full-strength border gives every field genuine visual weight.
 */
const fieldBase =
  'block w-full rounded-xl bg-secondary/40 text-foreground ' +
  'placeholder:text-muted-foreground/70 ' +
  'ring-1 ring-inset ring-foreground/[0.06] ' +
  'transition-[box-shadow,background-color,ring-color] duration-fast ease-out ' +
  'hover:bg-secondary/60 ' +
  'focus:outline-none focus:bg-card focus:ring-2 focus:ring-primary/40 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

const inputSize = 'h-10 px-3.5 text-sm text-start';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...rest },
  ref,
): JSX.Element {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        inputSize,
        invalid && 'border-destructive focus:border-destructive',
        className,
      )}
      {...rest}
    />
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...rest },
  ref,
): JSX.Element {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        'min-h-[2.5rem] px-3.5 py-2.5 text-sm text-start leading-relaxed',
        invalid && 'border-destructive focus:border-destructive',
        className,
      )}
      {...rest}
    />
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, children, ...rest },
  ref,
): JSX.Element {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        fieldBase,
        'h-10 ps-3.5 pe-9 text-sm text-start appearance-none cursor-pointer',
        "bg-[length:10px_10px] bg-no-repeat bg-[right_0.75rem_center] [background-image:url(\"data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2010%206'%3E%3Cpath%20fill='none'%20stroke='%23a8a8a4'%20stroke-width='1.5'%20stroke-linecap='round'%20stroke-linejoin='round'%20d='M1%201l4%204%204-4'/%3E%3C/svg%3E\")]",
        '[dir=rtl]:bg-[left_0.75rem_center]',
        invalid && 'border-destructive focus:border-destructive',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
