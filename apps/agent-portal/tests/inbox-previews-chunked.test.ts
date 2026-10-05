import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Owner, 2026-10-05: every inbox row read "No messages yet" while customers'
 * messages were plainly arriving.
 *
 * The preview read filtered on ALL listed conversation ids in one request.
 * Measured on production: 233 conversations -> a 10,704-character URL ->
 * CloudFront HTTP 414, swallowed into an empty map. Under that size the shared
 * 1,000-message cap still starved quiet chats (103 of 120 covered).
 */
const API = readFileSync(resolve(import.meta.dirname, '../src/features/inbox/api.ts'), 'utf8');
const fn = API.slice(
  API.indexOf('export function useConversationPreviews'),
  API.indexOf('export function useMessages'),
);

describe('inbox last-message previews', () => {
  it('reads in small batches, never one request for every conversation', () => {
    expect(fn).toMatch(/readChunked\(/);
    // 25 ids per request (URL ~1.2k chars), 4 in flight.
    expect(fn).toMatch(/\n\s*25,\n\s*4,\n/);
  });

  it('no longer sends the whole id list in a single filter', () => {
    expect(fn).not.toMatch(/conversation: \{ _in: conversationIds \}/);
  });
});
