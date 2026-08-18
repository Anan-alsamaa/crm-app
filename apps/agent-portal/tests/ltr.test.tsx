import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Ltr } from '@yiji/ui';

/**
 * packages/ui has no runner of its own, so its primitives are exercised through
 * the portal that consumes them — which also proves the export is reachable.
 */
describe('Ltr', () => {
  it('pins direction so a leading + is not moved to the end', () => {
    // The reported symptom: +966521708571 rendered as 966521708571+ on an
    // Arabic page, which reads as bad data rather than as a layout bug.
    render(<Ltr>+966521708571</Ltr>);
    expect(screen.getByText('+966521708571')).toHaveAttribute('dir', 'ltr');
  });

  it('isolates the run so it cannot reorder the Arabic around it', () => {
    render(<Ltr>ORD-4471</Ltr>);
    expect(screen.getByText('ORD-4471').className).toContain('unicode-bidi:isolate');
  });

  it('can be a block when a span will not do', () => {
    const { container } = render(<Ltr as="div">x</Ltr>);
    expect(container.querySelector('div')).toHaveAttribute('dir', 'ltr');
  });

  it('keeps the caller’s own classes', () => {
    render(<Ltr className="tabular-nums">7</Ltr>);
    expect(screen.getByText('7').className).toContain('tabular-nums');
  });
});
