import { describe, it, expect } from 'vitest';
import { draftLanguage, prompts } from '../src/prompts/index.js';

/**
 * An Arabic draft enhanced from an English portal came back in English
 * (owner, 2026-10-10). The draft's language must win over the portal language.
 */
const ctx = { messages: [{ sender: 'customer', content: 'وين طلبي؟' }] } as never;

describe('Enhance keeps the language the agent wrote in', () => {
  it('detects the draft language', () => {
    expect(draftLanguage('نعتذر عن التأخير في طلبك')).toBe('ar');
    expect(draftLanguage('sorry for the delay')).toBe('en');
    expect(draftLanguage('طلبك رقم 1334028 order متأخر')).toBe('ar');
    expect(draftLanguage('1334028')).toBeUndefined();
    expect(draftLanguage(undefined)).toBeUndefined();
  });

  it('an Arabic draft from an English portal is answered in Arabic', () => {
    const p = prompts.suggestReply(ctx, 'نعتذر عن التأخير', 'en');
    expect(p.system).toContain('WRITE THE REPLY IN THIS LANGUAGE: ar.');
    expect(p.system).not.toContain('LANGUAGE: en.');
  });

  it('an English draft from an Arabic portal is answered in English', () => {
    expect(prompts.suggestReply(ctx, 'sorry for the delay', 'ar').system).toContain(
      'WRITE THE REPLY IN THIS LANGUAGE: en.',
    );
  });

  it('no draft still follows the portal language', () => {
    expect(prompts.suggestReply(ctx, undefined, 'ar').system).toContain(
      'WRITE THE REPLY IN THIS LANGUAGE: ar.',
    );
  });
});
