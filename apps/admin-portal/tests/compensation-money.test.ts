import { describe, it, expect } from 'vitest';
import { money } from '../src/features/coupon-approvals/AllCompensationPage.js';

describe('money', () => {
  // The bug that took the page down: Postgres returns `numeric` as a STRING,
  // because arbitrary precision does not survive a JavaScript float. The first
  // version called .toFixed on it.
  it('accepts the string Postgres actually sends', () => {
    expect(money('0.00000')).toBe('0');
    expect(money('25.00000')).toBe('25');
    expect(money('12.50000')).toBe('12.5');
  });

  it('accepts a real number too', () => {
    expect(money(25)).toBe('25');
    expect(money(12.5)).toBe('12.5');
  });

  it('shows nothing rather than a zero for an unset column', () => {
    expect(money(null)).toBe('');
    expect(money(undefined)).toBe('');
    expect(money('')).toBe('');
  });

  it('keeps halalas when there are any', () => {
    expect(money('10.05000')).toBe('10.05');
  });

  it('hands back anything it cannot read rather than NaN', () => {
    expect(money('not a number')).toBe('not a number');
  });
});
