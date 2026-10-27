import type {
  InputHTMLAttributes,
  JSX,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from './cn.js';
import { nodeText } from './optionSearch.js';
import { SelectMenu, type SelectMenuOption } from './SelectMenu.js';

/*
 * Field base — inset dark well + inset hairline + real focus ring. Fields read
 * as wells carved into the surface: the `--input` token fill (charcoal on dark,
 * soft grey on light) plus the hairline gives every field genuine visual weight
 * without a raw 1px border.
 */
const fieldBase =
  'block w-full rounded-2xl bg-input text-foreground ' +
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

/** The `<option>`s a caller wrote, flattened out of fragments and optgroups. */
function collectOptions(children: ReactNode): SelectMenuOption[] {
  const out: SelectMenuOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode; disabled?: boolean }>(child))
      return;
    if (child.type === Fragment || child.type === 'optgroup') {
      out.push(...collectOptions(child.props.children));
      return;
    }
    if (child.type !== 'option') return;
    const text = nodeText(child.props.children);
    out.push({
      value: child.props.value === undefined ? text : String(child.props.value),
      label: text,
      disabled: child.props.disabled,
    });
  });
  return out;
}

/*
 * A form select that behaves like every other dropdown in the product: the
 * styled `SelectMenu` with type-to-filter (owner, 2026-10-26), instead of the
 * OS's own pop-up list.
 *
 * The real `<select>` is still rendered — visually hidden — and stays the
 * source of truth, so every existing caller keeps working unchanged: React Hook
 * Form's `register()` (ref + onChange + onBlur + name), a controlled
 * `value`/`onChange`, `<FormField>`'s label association, `required`, form
 * submission, and tests that drive it with `fireEvent.change`. Picking from the
 * menu sets the native value and fires a real `change` event on it.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, children, disabled, ...rest },
  ref,
): JSX.Element {
  const nativeRef = useRef<HTMLSelectElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLSelectElement | null) => {
      nativeRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const options = collectOptions(children);
  const controlled = rest.value !== undefined;
  const [domValue, setDomValue] = useState(() =>
    String(rest.defaultValue ?? options[0]?.value ?? ''),
  );
  const [labelText, setLabelText] = useState<string | undefined>(undefined);

  /*
   * An uncontrolled select (react-hook-form) can change under us — `reset()`
   * writes the DOM value directly — so read it back after every render. The
   * <FormField> label names the menu's trigger too — through `title`, not
   * `aria-label`: the label already points at the hidden select, and a second
   * element answering to the same label would make `getByLabelText` (and
   * Playwright's `getByLabel`) ambiguous for every existing test.
   */
  useLayoutEffect(() => {
    const el = nativeRef.current;
    if (!el) return;
    if (el.value !== domValue) setDomValue(el.value);
    const name = el.labels?.[0]?.textContent?.trim() || undefined;
    if (name !== labelText) setLabelText(name);
  });

  const pick = (v: string) => {
    const el = nativeRef.current;
    if (!el) return;
    // The prototype setter, so React's own value bookkeeping sees the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // react-hook-form marks a field touched on blur; the hidden select never
    // gets real focus, so tell it the interaction is over.
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    setDomValue(el.value);
  };

  return (
    <>
      <select
        ref={setRefs}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        {...rest}
      >
        {children}
      </select>
      <SelectMenu
        value={controlled ? String(rest.value) : domValue}
        onChange={pick}
        options={options}
        invalid={invalid}
        disabled={disabled}
        fullWidth
        title={rest['aria-label'] ?? labelText}
        className={className}
      />
    </>
  );
});
