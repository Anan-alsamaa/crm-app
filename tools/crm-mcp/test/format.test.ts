import { describe, expect, it } from 'vitest';
import {
  HEADER,
  phoneNeedle,
  redact,
  riyadhRange,
  when,
  whenYiji,
  withHeader,
} from '../src/format.js';

describe('header', () => {
  it('is the exact production line, first in every result', () => {
    expect(HEADER).toBe('[PRODUCTION · read-only · crm-api.anan.sa]');
    expect(withHeader('body').split('\n')[0]).toBe(HEADER);
  });
});

describe('time and phone formatting', () => {
  it('shows Riyadh time first, UTC in brackets', () => {
    expect(when('2026-10-08T22:30:00.000Z')).toBe('2026-10-09 01:30 KSA (22:30Z)');
    expect(when('2026-10-08T22:30:00')).toBe('2026-10-09 01:30 KSA (22:30Z)');
    expect(when(null)).toBe('-');
  });

  it('reads a naked Yiji stamp as Riyadh wall-clock, not UTC', () => {
    expect(whenYiji('2026-10-08T14:00:00')).toBe('2026-10-08 14:00 KSA (11:00Z)');
    expect(whenYiji('2026-10-08T11:00:00Z')).toBe('2026-10-08 14:00 KSA (11:00Z)');
  });

  it('turns Riyadh days into UTC bounds, end inclusive', () => {
    expect(riyadhRange('2026-10-01', '2026-10-01')).toEqual({
      gte: '2026-09-30T21:00:00.000Z',
      lt: '2026-10-01T21:00:00.000Z',
    });
  });

  it('normalises typed phones to the stored 05 form', () => {
    expect(phoneNeedle('+966 55 123 4567')).toBe('0551234567');
    expect(phoneNeedle('00966551234567')).toBe('0551234567');
    expect(phoneNeedle('551234567')).toBe('0551234567');
    expect(phoneNeedle('0551234567')).toBe('0551234567');
    expect(phoneNeedle('4567')).toBe('4567');
  });
});

describe('redact', () => {
  it('hides secret-looking keys at any depth but keeps token COUNTS', () => {
    expect(
      redact({
        support_settings: { yiji: { apiKey: 'k', password: 'p', client_secret: 's' } },
        access_token: 't',
        input_tokens: 10,
        token: 'x',
        name: 'ok',
      }),
    ).toEqual({
      support_settings: {
        yiji: { apiKey: '[redacted]', password: '[redacted]', client_secret: '[redacted]' },
      },
      access_token: '[redacted]',
      input_tokens: 10,
      token: '[redacted]',
      name: 'ok',
    });
  });
});
