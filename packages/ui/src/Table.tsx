import type { HTMLAttributes, JSX, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn.js';

/*
 * Premium data-table primitives. One rounded floating surface, a sticky
 * uppercase header, comfortable 44px rows with a soft hover, and cells that
 * inherit the app's type scale. Compose:
 *
 *   <TableSurface>
 *     <Table>
 *       <thead><tr><Th>…</Th></tr></thead>
 *       <tbody><Tr><Td>…</Td></Tr></tbody>
 *     </Table>
 *   </TableSurface>
 */

export function TableSurface({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'overflow-auto rounded-2xl bg-card ring-1 ring-foreground/[0.05] shadow-soft',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Table({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement>): JSX.Element {
  return (
    <table className={cn('w-full border-collapse text-sm', className)} {...rest}>
      {children}
    </table>
  );
}

export function Th({
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 h-11 whitespace-nowrap bg-card/95 px-4 text-start text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground backdrop-blur',
        'border-b border-border',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Tr({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return (
    <tr
      className={cn(
        'border-b border-border last:border-b-0 transition-colors duration-fast ease-out hover:bg-secondary/50',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element {
  return (
    <td className={cn('h-11 px-4 align-middle text-foreground', className)} {...rest}>
      {children}
    </td>
  );
}
