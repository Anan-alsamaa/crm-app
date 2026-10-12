import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';

type CellProps = { className?: string; children?: ReactNode };

/**
 * A column's header WITH its resize handle INSIDE the cell (2026-10-12).
 *
 * Several headers are written as `<>{comment}<Th>…</Th></>`. Cloning that
 * fragment put the handle BESIDE the <th>, as a stray child of the <tr>, and
 * the browser drew it as an extra blank column: every header slid right of its
 * values. So a fragment is unwrapped to its one element first; anything that
 * still is not a single cell is returned untouched, with no handle, rather
 * than ever adding a node to the row.
 */
export function headerWithHandle(th: ReactNode, handle: ReactNode): ReactNode {
  let cell: ReactNode = th;
  if (isValidElement(cell) && cell.type === Fragment) {
    const kids = Children.toArray((cell.props as { children?: ReactNode }).children).filter(
      isValidElement,
    );
    if (kids.length !== 1) return th;
    cell = kids[0];
  }
  if (!isValidElement(cell) || cell.type === Fragment) return th;
  const el = cell as ReactElement<CellProps>;
  const className = [el.props.className, 'relative'].filter(Boolean).join(' ');
  return cloneElement(el, { className }, el.props.children, handle);
}
