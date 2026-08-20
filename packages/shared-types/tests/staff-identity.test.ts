import { describe, it, expect } from 'vitest';
import {
  isStaffIdentity,
  loginIdentity,
  loginNameFromIdentity,
  normalizeLoginName,
  staffDisplayName,
  staffFullName,
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
  it('is the FIRST name — there is no separate display-name field', () => {
    // One was tried and removed: it asked an admin to type a third name for
    // somebody whose first name was already on the form, and the two drifted.
    expect(staffDisplayName({ first_name: 'Ali', last_name: 'Hassan' })).toBe('Ali');
  });

  it('shows the employee id before it ever shows a minted address', () => {
    // "4417" identifies a real person; "4417@staff.example.com" is an id
    // wearing a domain nobody typed and nobody can email.
    expect(staffDisplayName({ login_name: '4417', email: '4417@staff.example.com' })).toBe('4417');
    expect(staffDisplayName({ email: '4417@staff.example.com' })).toBe('4417');
  });

  it('never renders as an empty string', () => {
    // A row with no name on it cannot be acted on. "Unknown" at least says the
    // NAME is missing rather than the person.
    expect(staffDisplayName({})).toBe('Unknown');
    expect(staffDisplayName(null)).toBe('Unknown');
    expect(staffDisplayName({ first_name: '   ' })).toBe('Unknown');
  });
});

describe('staffFullName', () => {
  it('keeps two people with the same first name apart', () => {
    expect(staffFullName({ first_name: 'Ali', last_name: 'Hassan' })).toBe('Ali Hassan');
    expect(staffFullName({ first_name: 'Ali', last_name: 'Otaibi' })).toBe('Ali Otaibi');
  });

  it('falls back to whatever identifies the person when there is no name', () => {
    expect(staffFullName({ login_name: '4417' })).toBe('4417');
    expect(staffFullName({ first_name: 'Ali' })).toBe('Ali');
  });
});
