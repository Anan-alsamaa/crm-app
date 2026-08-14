import type { InputHTMLAttributes, JSX, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';

/*
 * Field base — inset dark well + inset hairline + real focus ring. Fields read
 * as wells carved into the surface: the `--input` token fill (charcoal on dark,
 * soft grey on light) plus the hairline gives every field genuine visual weight
 * without a raw 1px border.
 */
const fieldBase =
  'block w-full rounded-xl bg-input text-foreground ' +
  'placeholder:text-muted-foreground/60 ' +
  'ring-1 ring-inset ' +
  'transition-[box-shadow,background-color] duration-fast ease-out ' +
  'focus:outline-none focus-visible:ring-2 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

/*
 * Ring colour lives OUTSIDE the base so the invalid tone never fights the
 * default hairline — cn() is a plain string joiner, not tailwind-merge, so
 * conflicting utilities must never coexist on one element.
 */
const fieldRing = (invalid?: boolean): string =>
  invalid
    ? 'ring-destructive/60 focus-visible:ring-destructive/50'
    : 'ring-foreground/[0.08] hover:ring-foreground/[0.14] focus-visible:ring-primary/40';

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
      className={cn(fieldBase, inputSize, fieldRing(invalid), className)}
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
        fieldRing(invalid),
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
        // NB: keep this data URI free of ';' and raw quotes. A ';charset=utf-8'
        // here gets the declaration cut short once the prod CSS minifier strips
        // the url() quotes, which corrupts the following rule. Quotes are %27.
        'bg-[length:10px_10px] bg-no-repeat bg-[right_0.75rem_center] [background-image:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2010%206%27%3E%3Cpath%20fill=%27none%27%20stroke=%27%23a8a8a4%27%20stroke-width=%271.5%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%20d=%27M1%201l4%204%204-4%27/%3E%3C/svg%3E")]',
        '[dir=rtl]:bg-[left_0.75rem_center]',
        fieldRing(invalid),
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
