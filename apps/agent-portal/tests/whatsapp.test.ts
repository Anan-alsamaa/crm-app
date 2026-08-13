import { describe, it, expect } from 'vitest';
import { fillWaTemplate, saudiWaNumber, waUrl } from '../src/features/tickets/whatsapp.js';
import { revisionsToEntries } from '../src/features/tickets/ChangeHistory.js';

describe('saudiWaNumber', () => {
  it('converts the local 05 format to international', () => {
    expect(saudiWaNumber('0551234567')).toBe('966551234567');
  });

  it('restores the leading zero Excel ate', () => {
    // Excel stores 0551234567 as the number 551234567 — the most common way a
    // mobile arrives broken from an imported sheet.
    expect(saudiWaNumber('551234567')).toBe('966551234567');
  });

  it('accepts already-international forms, with or without 00', () => {
    expect(saudiWaNumber('966551234567')).toBe('966551234567');
    expect(saudiWaNumber('00966551234567')).toBe('966551234567');
  });

  it('ignores spaces and separators', () => {
    expect(saudiWaNumber('055 123 4567')).toBe('966551234567');
    expect(saudiWaNumber('+966 55-123-4567')).toBe('966551234567');
  });

  it('refuses anything that is not a Saudi mobile rather than guessing', () => {
    expect(saudiWaNumber('012345678')).toBeNull(); // landline prefix
    expect(saudiWaNumber('05512')).toBeNull(); // too short
    expect(saudiWaNumber('')).toBeNull();
    expect(saudiWaNumber(null)).toBeNull();
  });
});

describe('fillWaTemplate', () => {
  it('fills every placeholder from the ticket', () => {
    expect(
      fillWaTemplate('Order {order} for {name} at {restaurant} ({brand})', {
        order: '946641',
        name: 'Saad',
        brand: 'Casa Pasta',
        restaurant: 'LCP-032',
      }),
    ).toBe('Order 946641 for Saad at LCP-032 (Casa Pasta)');
  });

  it('collapses a missing placeholder to blank instead of sending {order} to a customer', () => {
    expect(fillWaTemplate('Order {order} — {name}', { order: null, name: 'Saad' })).toBe(
      'Order — Saad',
    );
  });
});

describe('waUrl', () => {
  it('builds the wa.me link with the message encoded', () => {
    expect(waUrl('0551234567', 'مرحباً')).toBe(
      `https://wa.me/966551234567?text=${encodeURIComponent('مرحباً')}`,
    );
  });

  it('returns null when there is no usable number — the caller shows the toast', () => {
    expect(waUrl('nope', 'hi')).toBeNull();
  });
});

describe('revisionsToEntries', () => {
  const rev = (
    id: number,
    action: string,
    delta: Record<string, unknown> | null,
    data: Record<string, unknown> | null,
  ) => ({
    id,
    delta,
    data,
    activity: { id, action, timestamp: `2026-08-13T0${id}:00:00Z`, user: 'u1' },
  });

  it('derives old → new from the PREVIOUS revision snapshot', () => {
    const entries = revisionsToEntries([
      rev(1, 'create', null, { priority: 'medium', status: 'new' }),
      rev(2, 'update', { priority: 'high' }, { priority: 'high', status: 'new' }),
    ]);
    // Newest first for display.
    expect(entries[0]!.changes).toEqual([{ field: 'priority', from: 'medium', to: 'high' }]);
    expect(entries[1]!.action).toBe('create');
  });

  it('drops bookkeeping noise and no-op writes', () => {
    const entries = revisionsToEntries([
      rev(1, 'create', null, { priority: 'medium' }),
      // date_updated is noise; priority "changed" to its own value is a no-op.
      rev(2, 'update', { date_updated: 'x', priority: 'medium' }, { priority: 'medium' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('create');
  });

  it('shows an empty old value as an em dash, not "null"', () => {
    const entries = revisionsToEntries([
      rev(1, 'create', null, { coupon_code: null }),
      rev(2, 'update', { coupon_code: 'OPS-1' }, { coupon_code: 'OPS-1' }),
    ]);
    expect(entries[0]!.changes[0]).toEqual({ field: 'coupon_code', from: '—', to: 'OPS-1' });
  });
});
