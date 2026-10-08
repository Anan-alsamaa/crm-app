import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MV-1 (EMA-70): every coupon request / late-order decision written from this
 * portal carries its vendor — from the caller, else the ticket, the chat or
 * the customer, else the single active vendor; never a guess between two.
 */

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, { vendor?: unknown }>>,
  vendors: [] as Array<{ id: string; status?: string }>,
  fail: false,
}));

vi.mock('@directus/sdk', () => ({
  readItem: (collection: string, id: string) => ({ kind: 'one', collection, id }),
  readItems: (collection: string) => ({ kind: 'many', collection }),
}));
vi.mock('../src/lib/directus.js', () => ({
  directus: {
    request: vi.fn(async (q: { kind: string; collection: string; id?: string }) => {
      if (db.fail) throw new Error('403');
      if (q.kind === 'many') return db.vendors;
      const row = db.rows[q.collection]?.[q.id!];
      if (!row) throw new Error('404');
      return row;
    }),
  },
}));

import {
  resetRecordVendorCache,
  resolveRecordVendor,
  vendorField,
} from '../src/lib/record-vendor.js';

beforeEach(() => {
  db.rows = {};
  db.vendors = [{ id: 'v-yiji', status: 'active' }];
  db.fail = false;
  resetRecordVendorCache();
});

describe('resolveRecordVendor', () => {
  it('explicit wins', async () => {
    expect(await resolveRecordVendor({ explicit: 'v-x', ticket: 't1' })).toBe('v-x');
  });

  it('takes the ticket’s vendor, then the chat’s, then the customer’s', async () => {
    db.rows = {
      tickets: { t1: { vendor: 'v-ticket' }, t2: { vendor: null } },
      conversations: { c1: { vendor: { id: 'v-chat' } } },
      contacts: { k1: { vendor: 'v-contact' } },
    };
    expect(await resolveRecordVendor({ ticket: 't1', contact: 'k1' })).toBe('v-ticket');
    expect(await resolveRecordVendor({ ticket: 't2', conversation: 'c1' })).toBe('v-chat');
    expect(await resolveRecordVendor({ ticket: 't2', contact: 'k1' })).toBe('v-contact');
  });

  it('falls back to the single active vendor, and to nothing with two', async () => {
    expect(await resolveRecordVendor({})).toBe('v-yiji');
    resetRecordVendorCache();
    db.vendors = [
      { id: 'v-yiji', status: 'active' },
      { id: 'v-two', status: 'active' },
    ];
    expect(await resolveRecordVendor({})).toBeNull();
  });

  it('never throws: unreadable sources give an empty field, not a failed save', async () => {
    db.fail = true;
    expect(await vendorField({ ticket: 't1', contact: 'k1' })).toEqual({});
  });
});
