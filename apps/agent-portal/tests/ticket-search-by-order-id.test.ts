import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toComplaintRow } from '../src/features/complaints/api.js';

/**
 * SEARCHING A TICKET BY ITS ORDER NUMBER.
 *
 * Reported by operations (2026-10-03): the tickets page search does not find
 * tickets by order id.
 *
 * The search itself was fine — `ticket-filter.ts` matches the needle against
 * `row.orderNumber`. The fault was where that value came from:
 *
 *     orderNumber: snap?.orderId ? String(snap.orderId) : ''
 *
 * built SOLELY from the `order_snapshot` json blob, while the field list never
 * requested the `order_id` COLUMN beside it. That column exists for exactly
 * this reason — its own doc comment says "searchable copy of
 * order_snapshot.orderId — json columns cannot be filtered" — and it was not
 * being read.
 *
 * A ticket raised from the LATE-ORDERS queue is precisely the broken case: it
 * is created with `order_id` set and NO snapshot, so the number sat in the
 * database and the search could never see it.
 */

const base = {
  id: 'tk-1',
  status: 'pending',
  subject: null,
  complaint_date: null,
  first_responded_at: null,
  first_response_due_at: null,
  date_created: null,
  description: null,
  complaint_type: null,
  service_type: null,
  complaint_source: null,
  communication_method: null,
  response_desc: null,
  compensation: null,
  coupon_code: null,
  coupon_value: null,
  coupon_percent: null,
  order_snapshot: null,
  order_id: null,
  store_snapshot: null,
  contact: null,
} as Parameters<typeof toComplaintRow>[0];

describe('the order number a ticket is searched by', () => {
  /* THE REGRESSION ITSELF: a late-order ticket has the column and no snapshot. */
  it('comes from the order_id column when there is no snapshot', () => {
    expect(toComplaintRow({ ...base, order_id: '1328524' }, 'Agent').orderNumber).toBe('1328524');
  });

  /* Still works the old way for a ticket raised from a chat, which carries a
     snapshot and (on older rows) no column. */
  it('falls back to the snapshot when the column is empty', () => {
    expect(
      toComplaintRow({ ...base, order_snapshot: { orderId: '99887' } }, 'Agent').orderNumber,
    ).toBe('99887');
  });

  /* The column is the authority: it is the one always written, and a snapshot
     is a copy taken at one moment. */
  it('prefers the column over the snapshot', () => {
    expect(
      toComplaintRow({ ...base, order_id: '111', order_snapshot: { orderId: '222' } }, 'Agent')
        .orderNumber,
    ).toBe('111');
  });

  /* A numeric id must not become "[object Object]" or a stray null. */
  it('renders a numeric order id as its digits', () => {
    expect(
      toComplaintRow({ ...base, order_snapshot: { orderId: 4242 } }, 'Agent').orderNumber,
    ).toBe('4242');
  });

  it('is an empty string when there is no order at all', () => {
    expect(toComplaintRow(base, 'Agent').orderNumber).toBe('');
  });
});

/**
 * AND THE COLUMN MUST ACTUALLY BE FETCHED.
 *
 * Mapping it is useless if the query never asks for it — Directus returns
 * `undefined` for an unrequested field, which falls straight back to the
 * snapshot and restores the bug invisibly.
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

describe('the tickets query', () => {
  it('requests the order_id column', () => {
    expect(read('src/features/complaints/api.ts')).toMatch(/'order_id',/);
  });

  /* The admin portal had the same fault: it FETCHED the column and then
     ignored it in the mapping. */
  it('is matched by the admin report', () => {
    const ADMIN = readFileSync(
      resolve(import.meta.dirname, '../../admin-portal/src/features/report-exports/api.ts'),
      'utf8',
    );
    expect(ADMIN).toMatch(/orderNumber: String\(t\.order_id \?\? snap\?\.orderId \?\? ''\)/);
  });
});
