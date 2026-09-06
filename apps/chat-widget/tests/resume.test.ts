import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationStorageKey,
  forgetConversation,
  recallConversation,
  rememberConversation,
} from '../src/resume.js';

/** An unsigned token whose payload carries the given claims (base64url, no padding). */
function tokenWith(claims: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${b64}.sig`;
}

const WALK_IN = tokenWith({ vendor_id: '1', customer_id: 'cust-0501234567', walk_in: true });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the key is the customer the token names', () => {
  it('derives it from vendor + customer, never from the token text', () => {
    // A walk-in token is re-minted every visit; the customer behind it is not.
    const again = tokenWith({ vendor_id: '1', customer_id: 'cust-0501234567', iat: 99 });
    expect(conversationStorageKey(WALK_IN)).toBe('yiji.conversation.1.cust-0501234567');
    expect(conversationStorageKey(again)).toBe(conversationStorageKey(WALK_IN));
  });

  it('separates two numbers typed on the same device', () => {
    const other = tokenWith({ vendor_id: '1', customer_id: 'cust-0509999999' });
    rememberConversation(WALK_IN, 'conv-a');
    expect(recallConversation(other)).toBeNull();
  });

  it('survives an Arabic name in the payload', () => {
    // Byte-wise base64 then UTF-8; a naive atob -> JSON.parse mangles this.
    const named = tokenWith({ vendor_id: '1', customer_id: 'c1', name: 'سارة' });
    expect(conversationStorageKey(named)).toBe('yiji.conversation.1.c1');
  });

  it('gives no key for a token it cannot read, so nothing is ever stored under junk', () => {
    expect(conversationStorageKey('not-a-jwt')).toBeNull();
    expect(conversationStorageKey('a.!!!.c')).toBeNull();
    expect(conversationStorageKey(tokenWith({ vendor_id: '1' }))).toBeNull();
    rememberConversation('not-a-jwt', 'conv-x');
    expect(localStorage.length).toBe(0);
  });
});

describe('remember / recall / forget', () => {
  it('round-trips the id this device was handed', () => {
    expect(recallConversation(WALK_IN)).toBeNull();
    rememberConversation(WALK_IN, 'c1f4e7a0-2b3d-4c5e-8f90-1a2b3c4d5e6f');
    expect(recallConversation(WALK_IN)).toBe('c1f4e7a0-2b3d-4c5e-8f90-1a2b3c4d5e6f');
    forgetConversation(WALK_IN);
    expect(recallConversation(WALK_IN)).toBeNull();
  });

  it('treats storage that throws as an empty memory, not a broken chat', () => {
    // Private mode on some browsers: every accessor throws.
    const deny = () => {
      throw new Error('denied');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(deny);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(deny);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(deny);
    expect(() => rememberConversation(WALK_IN, 'conv-a')).not.toThrow();
    expect(recallConversation(WALK_IN)).toBeNull();
    expect(() => forgetConversation(WALK_IN)).not.toThrow();
  });
});
