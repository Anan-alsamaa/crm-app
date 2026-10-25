import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/directus.js', () => ({ directus: { request: vi.fn() } }));

import { yijiVendorOption } from '../src/features/inbox/start-chat.js';

/**
 * The start-chat dialog preselects the Yiji vendor (owner, 2026-10-25) — found
 * in the vendor directory by name, never by a hard-coded id.
 */
const opt = (id: string, name: string, platformId: string | null = `p-${id}`) => ({
  id,
  name,
  platformId,
});

describe('the default vendor of an agent-started chat', () => {
  it('is the vendor named Yiji, whatever its position or case', () => {
    expect(yijiVendorOption([opt('a', 'Anan'), opt('b', 'YIJI')])?.id).toBe('b');
    expect(yijiVendorOption([opt('a', 'Anan'), opt('b', 'ييجي')])?.id).toBe('b');
  });

  it('prefers an exact name over one that only contains it', () => {
    expect(yijiVendorOption([opt('a', 'Yiji Test'), opt('b', 'Yiji')])?.id).toBe('b');
  });

  it('takes a single partial match, but guesses nothing between two', () => {
    expect(yijiVendorOption([opt('a', 'Yiji App'), opt('b', 'Anan')])?.id).toBe('a');
    expect(yijiVendorOption([opt('a', 'Yiji App'), opt('b', 'Yiji Demo')])).toBeUndefined();
  });

  it('never defaults to a vendor that cannot be messaged', () => {
    expect(yijiVendorOption([opt('a', 'Yiji', null)])).toBeUndefined();
  });

  it('is no default at all when there is no Yiji vendor', () => {
    expect(yijiVendorOption([opt('a', 'Anan'), opt('b', 'Other')])).toBeUndefined();
  });
});
