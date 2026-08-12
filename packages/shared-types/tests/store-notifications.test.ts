import { describe, it, expect } from 'vitest';
import {
  isNotifyingType,
  storeNotificationDraft,
  type StoreNotificationInput,
} from '../src/store-notifications.js';

const ENABLED = ['Missing item', 'Order cold'];

const input = (over: Partial<StoreNotificationInput> = {}): StoreNotificationInput => ({
  ticketId: 't1',
  storeId: 's1',
  complaintType: 'Missing item',
  description: 'Two of the four burgers were missing.',
  resolutionNotes: 'Refunded and apologised.',
  ...over,
});

describe('isNotifyingType', () => {
  it('notifies only for the types operations chose', () => {
    expect(isNotifyingType('Missing item', ENABLED)).toBe(true);
    // Nothing the branch can act on: the app broke, not the kitchen.
    expect(isNotifyingType('Technical issue', ENABLED)).toBe(false);
  });

  it('survives a stray space or capital in the configuration', () => {
    // The enabled list is typed by an admin; a trailing space must not switch
    // a whole category off without anyone noticing.
    expect(isNotifyingType('Missing item', [' missing ITEM '])).toBe(true);
  });

  it('never notifies on a blank type', () => {
    expect(isNotifyingType('', ENABLED)).toBe(false);
    expect(isNotifyingType(null, ENABLED)).toBe(false);
    expect(isNotifyingType('   ', ENABLED)).toBe(false);
  });

  it('notifies nobody when nothing is configured', () => {
    // The safe direction. An empty list means "not set up yet", and treating
    // that as "send everything" would spray every branch on the first save.
    expect(isNotifyingType('Missing item', [])).toBe(false);
  });
});

describe('storeNotificationDraft', () => {
  it('carries the description and the resolution notes, and nothing else', () => {
    const out = storeNotificationDraft(input(), ENABLED);
    expect(out).toEqual({
      draft: {
        ticket: 't1',
        store: 's1',
        complaint_type: 'Missing item',
        description: 'Two of the four burgers were missing.',
        resolution_notes: 'Refunded and apologised.',
        status: 'queued',
      },
    });
    // The customer's name, phone, the coupon and the agent are the customer's
    // business with us, not the branch's.
    const keys = Object.keys((out as { draft: object }).draft);
    expect(keys).not.toContain('contact');
    expect(keys).not.toContain('coupon_code');
  });

  it('says which types do not notify rather than failing silently', () => {
    expect(storeNotificationDraft(input({ complaintType: 'Technical issue' }), ENABLED)).toEqual({
      skip: 'type-not-notifying',
    });
  });

  it('reports a missing branch only when the type would have notified', () => {
    expect(storeNotificationDraft(input({ storeId: null }), ENABLED)).toEqual({ skip: 'no-store' });
    // Not "no-store": nothing about this ticket would have been sent anyway,
    // and saying otherwise sends someone hunting for a branch to attach that
    // would change nothing.
    expect(
      storeNotificationDraft(input({ storeId: null, complaintType: 'Technical issue' }), ENABLED),
    ).toEqual({ skip: 'type-not-notifying' });
  });

  it('has nothing to send for an unclassified ticket', () => {
    expect(storeNotificationDraft(input({ complaintType: null }), ENABLED)).toEqual({
      skip: 'no-complaint-type',
    });
  });

  it('keeps "not written" as null rather than an empty string', () => {
    const out = storeNotificationDraft(input({ description: '  ', resolutionNotes: '' }), ENABLED);
    expect(out).toMatchObject({ draft: { description: null, resolution_notes: null } });
  });

  it('still queues when the resolution is not written yet', () => {
    // Common: the agent logs the complaint now and resolves it later. The
    // branch should hear what happened either way.
    const out = storeNotificationDraft(input({ resolutionNotes: null }), ENABLED);
    expect(out).toMatchObject({
      draft: { description: expect.any(String), resolution_notes: null },
    });
  });
});
