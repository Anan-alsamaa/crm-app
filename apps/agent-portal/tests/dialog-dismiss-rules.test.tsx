import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { useState } from 'react';
import { ConfirmDialog, DISMISS_FIRST_ATTR } from '@yiji/ui';

/**
 * WHEN A DIALOG MAY CLOSE ITSELF (owner, 2026-10-05).
 *
 * 1. A drag that starts inside the panel and ends over the backdrop is not a
 *    backdrop click — it closed the ticket-import popup mid-drag.
 * 2. A dialog can be made rigid: the import popup ignores the backdrop.
 * 3. An open suggestion list inside the dialog takes the FIRST outside press
 *    (and the first Esc); only a second one closes the dialog — one click used
 *    to throw away a half-written late-order decision.
 */

function Harness({
  onCancel,
  dismissOnBackdrop,
  withPopover = false,
}: {
  onCancel: () => void;
  dismissOnBackdrop?: boolean;
  withPopover?: boolean;
}) {
  const [popover, setPopover] = useState(withPopover);
  return (
    <ConfirmDialog
      open
      title="Decide"
      onConfirm={() => {}}
      onCancel={onCancel}
      dismissOnBackdrop={dismissOnBackdrop}
      description={
        <span>
          <input aria-label="reason" onPointerDown={() => setPopover(false)} />
          {popover && (
            <span role="listbox" {...{ [DISMISS_FIRST_ATTR]: '' }}>
              suggestions
            </span>
          )}
        </span>
      }
    />
  );
}

const backdrop = () => screen.getByRole('alertdialog').parentElement!;

/* A real press: pointerdown on one element, click delivered where they meet. */
function press(down: Element, clickTarget: Element = down) {
  fireEvent.pointerDown(down);
  fireEvent.click(clickTarget);
}

describe('dialog dismiss rules', () => {
  it('closes on a press that starts and ends on the backdrop', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    press(backdrop());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on a drag that started inside the panel', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    // Pressed on the input, released over the backdrop: the click lands there.
    press(screen.getByLabelText('reason'), backdrop());
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('ignores the backdrop entirely when rigid, but Esc still closes', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} dismissOnBackdrop={false} />);
    press(backdrop());
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('lets an open suggestion list absorb the first outside press', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} withPopover />);
    press(backdrop());
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes on the second press once the list is gone', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} withPopover />);
    // First press inside the dialog puts the list away (as QuickReplies does).
    press(screen.getByLabelText('reason'));
    expect(screen.queryByRole('listbox')).toBeNull();
    press(backdrop());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('leaves the first Esc to the open list', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} withPopover />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
