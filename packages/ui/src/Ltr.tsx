import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * Content that is always read left-to-right, wherever the page is going.
 *
 * A phone number, an order ID, a coupon code and an email address are written
 * left-to-right in every language. Dropped bare into an Arabic page they
 * inherit its direction, and the bidirectional algorithm moves any leading
 * neutral character to the other end: `+966521708571` renders as
 * `966521708571+`. It looks like a typo in the data rather than a layout bug,
 * which is why it survives so long unreported.
 *
 * `unicode-bidi: isolate` as well as `dir`, so the run cannot disturb the
 * ordering of the Arabic text around it either — a number set LTR inside an RTL
 * sentence still has to be isolated from its neighbours to sit in the right
 * place in the line.
 *
 * A span by default so it can sit inside a sentence; pass `as="div"` for a
 * block. Not for translated prose — only for strings that have no language.
 */
export interface LtrProps {
  children: ReactNode;
  className?: string;
  as?: 'span' | 'div' | 'dd' | 'td';
}

export function Ltr({ children, className, as: Tag = 'span' }: LtrProps) {
  return (
    <Tag dir="ltr" className={cn('[unicode-bidi:isolate]', className)}>
      {children}
    </Tag>
  );
}
