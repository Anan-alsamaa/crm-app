import { describe, it, expect } from 'vitest';
import { enhanceLocale } from '../src/features/conversation/enhance-locale.js';

/**
 * An Arabic draft enhanced from an English portal could come back in English
 * (owner, 2026-10-25). The request states the language the agent TYPED in.
 */
describe('Enhance asks in the language of the draft', () => {
  it('an Arabic draft is Arabic, even from an English portal', () => {
    expect(enhanceLocale('نعتذر عن التأخير في طلبك', 'en')).toBe('ar');
  });

  it('an English draft is English, even from an Arabic portal', () => {
    expect(enhanceLocale('sorry for the delay', 'ar-SA')).toBe('en');
  });

  it('a mostly-Arabic draft with an order number and a Latin word stays Arabic', () => {
    expect(enhanceLocale('طلبك رقم 1334028 order متأخر', 'en')).toBe('ar');
  });

  it('a draft with no letters falls back to the portal language', () => {
    expect(enhanceLocale('1334028 !!', 'ar')).toBe('ar');
    expect(enhanceLocale('1334028', 'en')).toBe('en');
    expect(enhanceLocale('1334028', undefined)).toBe('en');
  });
});
