import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, daySeparatorIds } from '../src/message-dates.js';
import { t } from '../src/i18n.js';

/* EMA-78: day separators in the customer's thread. */
const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo, d, h, 0, 0).toISOString();
const NOW = new Date(2026, 9, 21, 15, 0, 0);

describe('dayLabel', () => {
  it('says Today and Yesterday', () => {
    expect(dayLabel(at(2026, 9, 21, 0), 'en', t('en'), NOW)).toBe('Today');
    expect(dayLabel(at(2026, 9, 20, 23), 'en', t('en'), NOW)).toBe('Yesterday');
    expect(dayLabel(at(2026, 9, 21), 'ar', t('ar'), NOW)).toBe('اليوم');
    expect(dayLabel(at(2026, 9, 20), 'ar', t('ar'), NOW)).toBe('أمس');
  });

  it('dates anything older with day, month and year', () => {
    expect(dayLabel(at(2026, 9, 18), 'en', t('en'), NOW)).toBe('18 Oct 2026');
    const ar = dayLabel(at(2026, 9, 18), 'ar', t('ar'), NOW);
    expect(ar).toMatch(/[؀-ۿ]/);
  });

  it('is empty for a value that is not a date', () => {
    expect(dayLabel('nope', 'en', t('en'), NOW)).toBe('');
    expect(dayKey('nope')).toBe('');
    expect(dayKey(null)).toBe('');
  });
});

describe('daySeparatorIds', () => {
  it('opens a day only where the day changes', () => {
    const ids = daySeparatorIds([
      { id: 'a', createdAt: at(2026, 9, 18, 9) },
      { id: 'b', createdAt: at(2026, 9, 18, 10) },
      { id: 'c', createdAt: at(2026, 9, 20, 9) },
      { id: 'd', createdAt: at(2026, 9, 21, 9) },
      { id: 'e', createdAt: at(2026, 9, 21, 10) },
    ]);
    expect([...ids]).toEqual(['a', 'c', 'd']);
  });

  it('never lets an undated bubble split a day in two', () => {
    const ids = daySeparatorIds([
      { id: 'a', createdAt: at(2026, 9, 21, 9) },
      { id: 'x', createdAt: 'not-a-date' },
      { id: 'b', createdAt: at(2026, 9, 21, 10) },
    ]);
    expect([...ids]).toEqual(['a']);
  });
});
