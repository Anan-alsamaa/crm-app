import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import React, { useState } from 'react';
import { usePinnedWidth } from '../src/lib/pinned-width.js';

/*
 * The Late orders report showed a loading state FIRST and mounted its
 * scrollport later; the old mount-only effect never measured it, so --pin-w
 * was never set and the date range sat off-screen (owner, 2026-10-14).
 */
function Page() {
  const pinRef = usePinnedWidth();
  const [loaded, setLoaded] = useState(false);
  (globalThis as { load?: () => void }).load = () => setLoaded(true);
  if (!loaded) return <p>loading…</p>;
  return <div ref={pinRef} data-testid="scrollport" />;
}

describe('usePinnedWidth', () => {
  it('measures a scrollport that appears AFTER a loading state', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1200,
    });
    const { getByTestId } = render(<Page />);
    await act(async () => {
      (globalThis as { load?: () => void }).load?.();
    });
    expect(getByTestId('scrollport').style.getPropertyValue('--pin-w')).toBe('1200px');
  });
});
