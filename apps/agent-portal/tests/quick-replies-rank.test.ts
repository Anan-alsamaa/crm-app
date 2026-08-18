import { describe, it, expect } from 'vitest';
import { rankReplies } from '../src/features/conversation/QuickReplies.js';

const REPLIES = [
  { id: '1', label: 'Opening', text: 'Hello', lang: 'en' as const },
  { id: '2', label: 'Closing', text: 'Bye', lang: 'en' as const },
  { id: '3', label: 'افتتاحية', text: 'مرحبا', lang: 'ar' as const },
  { id: '4', label: 'إغلاق', text: 'شكرا', lang: 'ar' as const },
];
const ENGLISH_THREAD = 'my order never arrived';
const langs = (rs: ReturnType<typeof rankReplies>) => rs.map((r) => r.lang);

describe('rankReplies', () => {
  it('leads with the agent’s own language even when the thread is the other one', () => {
    // The reported bug: an agent working in Arabic saw four English buttons and
    // had to open "all 8" to reach any Arabic wording, on every English thread.
    expect(langs(rankReplies(REPLIES, ENGLISH_THREAD, '', 'ar')).slice(0, 2)).toEqual(['ar', 'ar']);
  });

  it('hides nothing — the other language is still there, just later', () => {
    expect(rankReplies(REPLIES, ENGLISH_THREAD, '', 'ar')).toHaveLength(4);
    expect(langs(rankReplies(REPLIES, ENGLISH_THREAD, '', 'ar'))).toContain('en');
  });

  it('an English agent on an English thread still gets English first', () => {
    expect(langs(rankReplies(REPLIES, ENGLISH_THREAD, '', 'en')).slice(0, 2)).toEqual(['en', 'en']);
  });

  it('falls back to the customer’s language when no portal language is given', () => {
    expect(langs(rankReplies(REPLIES, 'لم يصل طلبي', '')).slice(0, 2)).toEqual(['ar', 'ar']);
  });

  it('a search still filters across both languages', () => {
    expect(rankReplies(REPLIES, ENGLISH_THREAD, 'إغلاق', 'en').map((r) => r.id)).toEqual(['4']);
  });
});
