import { describe, it, expect } from 'vitest';
import {
  isStaffIdentity,
  loginIdentity,
  loginNameFromIdentity,
  normalizeLoginName,
  staffDisplayName,
} from '../src/staff-identity.js';

describe('loginIdentity', () => {
  it('turns an employee id into the identity Directus authenticates', () => {
    expect(loginIdentity('4417')).toBe('4417@staff.example.com');
  });

  it('treats the same id in any case as one person', () => {
    expect(loginIdentity('A17')).toBe('a17@staff.example.com');
    expect(normalizeLoginName('  A17 ')).toBe('a17');
  });

  it('passes a real email through untouched', () => {
    // Not a convenience fallback: every account that predates employee-id
    // login — the administrator included — still has to be able to sign in.
    expect(loginIdentity('e.habibi@anan.sa')).toBe('e.habibi@anan.sa');
  });

  it('returns null for nothing typed, rather than a half-built address', () => {
    expect(loginIdentity('')).toBeNull();
    expect(loginIdentity('   ')).toBeNull();
  });

  it('reads the employee id back out, and refuses to invent one', () => {
    expect(loginNameFromIdentity('4417@staff.example.com')).toBe('4417');
    expect(loginNameFromIdentity('e.habibi@anan.sa')).toBeNull();
    expect(isStaffIdentity('4417@staff.example.com')).toBe(true);
    expect(isStaffIdentity('e.habibi@anan.sa')).toBe(false);
  });
});

describe('staffDisplayName', () => {
  it('prefers the name the person chose to be called', () => {
    expect(
      staffDisplayName({ display_name: 'Abu Khalid', first_name: 'Ali', last_name: 'Hassan' }),
    ).toBe('Abu Khalid');
  });

  it('falls back to first + last, which is the old behaviour', () => {
    expect(staffDisplayName({ first_name: 'Ali', last_name: 'Hassan' })).toBe('Ali Hassan');
    expect(staffDisplayName({ first_name: 'Ali' })).toBe('Ali');
  });

  it('shows the employee id before it ever shows a minted address', () => {
    // "4417" identifies a real person; "4417@staff.example.com" is an id wearing a
    // domain nobody typed and nobody can email.
    expect(staffDisplayName({ login_name: '4417', email: '4417@staff.example.com' })).toBe('4417');
    expect(staffDisplayName({ email: '4417@staff.example.com' })).toBe('4417');
  });

  it('never renders as an empty string', () => {
    // A row with no name on it cannot be acted on. "Unknown" at least says the
    // NAME is missing rather than the person.
    expect(staffDisplayName({})).toBe('Unknown');
    expect(staffDisplayName(null)).toBe('Unknown');
    expect(staffDisplayName({ display_name: '   ' })).toBe('Unknown');
  });
});
