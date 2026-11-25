import { describe, it, expect, beforeEach } from 'vitest';
import type { BranchNotifyRule, StoreRecord } from '@yiji/shared-types';
import {
  createYijiInboundService,
  type NewTicketRow,
  type YijiInboundStore,
} from '../src/yiji-inbound.js';

/**
 * THE YIJI API USES THE AGENTS' OWN LISTS (owner, 25 Nov 2026).
 *
 * Yiji's app offers its customers the complaint and service types we hand
 * over, plus "Other" (recorded, no action). The API used to check a list frozen
 * in the code that had drifted from the Lists page: "Other" and "Wrong order"
 * were refused, two retired types were still accepted, and service types were
 * stored as "Dinning" / "TakeOut" / "Drive Thru" while agents store "Dine-in" /
 * "Takeout" / "Carhop" - one service type counted under two names.
 */

/* Production's Lists page on 25 Nov 2026, as read from option_lists. */
const PROD_COMPLAINT_TYPES = [
  'Roach found',
  'Driver attitude',
  'Foreign object found',
  'Product',
  'Other',
  'Late order',
  'Missing condiments',
  'Technical issue',
  'Missing item',
  'Accuracy',
  'Hospitality',
  'Wrong order',
  'Cleanness',
  'Instore preparation late order',
];
const PROD_SERVICE_TYPES = [
  'Takeout',
  'Dine-in',
  'Carhop',
  'Yiji Takeout',
  'Yiji Dine-in',
  'Pickup',
  'Delivery',
];

const STORE: StoreRecord = {
  id: 'store-1',
  code: 'LCP-001',
  name: 'Marina Mall D',
  city: 'Dammam',
  areaManager: null,
  chainManager: null,
  brandCode: 'LCP',
  brandName: 'Casa Pasta',
  yijiRestaurantId: '9',
};

class FakeStore implements YijiInboundStore {
  tickets: NewTicketRow[] = [];
  notifications: Array<Record<string, unknown>> = [];
  lists: Record<string, string[] | Error> = {
    complaint_type: PROD_COMPLAINT_TYPES,
    service_type: PROD_SERVICE_TYPES,
  };
  listReads = 0;
  rules: BranchNotifyRule[] = [];
  async yijiVendorId() {
    return 'vendor-yiji';
  }
  async findTicket() {
    return null;
  }
  async findCoupon() {
    return null;
  }
  async couponExists() {
    return false;
  }
  async ticketCoupons() {
    return [];
  }
  async stores() {
    return [STORE];
  }
  async upsertContact() {
    return 'contact-1';
  }
  async couponCodeTaken() {
    return false;
  }
  async createTicket(row: NewTicketRow) {
    this.tickets.push(row);
  }
  async createCoupon() {}
  async setTicketCompensation() {}
  async addTicketEvent() {}
  async actorId() {
    return 'user-yiji';
  }
  async branchNotifyRules() {
    return this.rules;
  }
  async queueStoreNotification(draft: Record<string, unknown>) {
    this.notifications.push(draft);
  }
  async optionList(list: 'complaint_type' | 'service_type') {
    this.listReads++;
    const v = this.lists[list];
    if (v instanceof Error) throw v;
    return v ?? [];
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let store: FakeStore;
let clock: number;
let svc: ReturnType<typeof createYijiInboundService>;
let n = 0;
beforeEach(() => {
  store = new FakeStore();
  clock = Date.parse('2026-11-25T12:00:00.000Z');
  n = 0;
  svc = createYijiInboundService({
    store,
    logger: silent,
    now: () => new Date(clock),
    newId: () => `id-${++n}`,
    sleep: async () => {},
    retryDelaysMs: [0, 0],
  });
});

let seq = 0;
const body = (over: Record<string, unknown> = {}) => ({
  customer: { phone: '0515553891' },
  orderNumber: '1350658',
  // A different second each call, so every request is a new complaint.
  occurredAt: new Date(Date.parse('2026-11-25T15:05:18+03:00') + ++seq * 1000).toISOString(),
  restaurantId: '9',
  complaintType: 'Instore preparation late order',
  serviceType: 'Pickup',
  description: 'Test',
  ...over,
});

const last = () => store.tickets[store.tickets.length - 1]!;

describe('complaint types: the Lists page decides', () => {
  it('accepts "Other" and "Wrong order", which the frozen list refused', async () => {
    await svc.createTicket(body({ complaintType: 'Other' }));
    expect(last().complaint_type).toBe('Other');
    await svc.createTicket(body({ complaintType: 'wrong ORDER' }));
    expect(last().complaint_type).toBe('Wrong order'); // the Lists page spelling
  });

  it('refuses a type the agents no longer have, naming the live list', async () => {
    await expect(svc.createTicket(body({ complaintType: 'Order cold' }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.createTicket(body({ complaintType: 'Order cold' }))).rejects.toSatisfy(
      (e: unknown) => JSON.stringify((e as { toBody(): unknown }).toBody()).includes('Wrong order'),
    );
    expect(store.tickets).toHaveLength(0);
  });

  it('"Other" is recorded but tells no branch; a branch type still does', async () => {
    await svc.createTicket(body({ complaintType: 'Other' }));
    expect(store.notifications).toHaveLength(0);
    await svc.createTicket(body({ complaintType: 'Missing item' }));
    expect(store.notifications).toHaveLength(1);
  });
});

describe("service types: one spelling, the agents' one", () => {
  it.each([
    ['Dinning', 'Dine-in'],
    ['Dine-in', 'Dine-in'],
    ['TakeOut', 'Takeout'],
    ['takeaway', 'Takeout'],
    ['Drive Thru', 'Carhop'],
    ['pickup', 'Pickup'],
    ['Yiji Dine-in', 'Yiji Dine-in'],
  ])('%s is stored as %s', async (sent, stored) => {
    await svc.createTicket(body({ serviceType: sent }));
    expect(last().service_type).toBe(stored);
  });

  it('refuses a service type that is on no list', async () => {
    await expect(svc.createTicket(body({ serviceType: 'Teleport' }))).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('never a refusal because the CRM could not read its own lists', () => {
  it('an unreadable list falls back to the built-in vocabulary', async () => {
    store.lists = { complaint_type: new Error('403'), service_type: new Error('403') };
    await svc.createTicket(body({ complaintType: 'Late order', serviceType: 'Dine-in' }));
    expect(last().complaint_type).toBe('Late order');
    expect(last().service_type).toBe('Dinning'); // the old behaviour, unchanged
  });

  it('an empty list falls back too', async () => {
    store.lists = { complaint_type: [], service_type: [] };
    await svc.createTicket(body());
    expect(last().complaint_type).toBe('Instore preparation late order');
  });

  it('reads the lists at most once a minute', async () => {
    await svc.createTicket(body());
    await svc.createTicket(body());
    expect(store.listReads).toBe(2); // one per list
    clock += 61_000;
    await svc.createTicket(body());
    expect(store.listReads).toBe(4);
  });
});
