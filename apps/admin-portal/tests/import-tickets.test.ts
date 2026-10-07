import { describe, it, expect, vi } from 'vitest';
import { buildStoreIndex, type StoreRecord } from '@yiji/shared-types';
import { parseTicketsCsv } from '@yiji/reports';
import {
  planImport,
  runImport,
  ticketIdentity,
  type ImportPlan,
  type PlanContext,
} from '../src/features/report-exports/import-tickets.js';

/**
 * The rules here are not hypothetical — every one of them is a row that went
 * wrong (or would have) while loading the real 1,673-row operations sheet.
 */

const STORES: StoreRecord[] = [
  {
    id: 'store-1',
    code: 'LCP-038',
    name: 'Yarmouk Plaza',
    city: 'Riyadh',
    areaManager: 'Area Person',
    chainManager: 'Chain Person',
    brandCode: 'LCP',
    brandName: 'Casa Pasta',
    brandYijiName: 'La Casa Pasta',
    yijiRestaurantId: null,
  },
];

const HEADER =
  'date,time,brand,restaurant_name,service_type,complaint_type,customer_mobile,complaint_description,order_number,agent';

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    index: buildStoreIndex(STORES),
    existing: new Set<string>(),
    contactByPhone: new Map(),
    agentByName: new Map([['faisal', 'user-faisal']]),
    vendorId: 'vendor-1',
    ...over,
  };
}

const plan = (csv: string, over: Partial<PlanContext> = {}): ImportPlan =>
  planImport(parseTicketsCsv(csv).rows, ctx(over));

describe('planImport', () => {
  it('resolves the branch, the customer and the agent from one row', () => {
    const p = plan(
      `${HEADER}\n2026-01-01,22:40,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,Wrong drink,451351,Faisal`,
    );

    expect(p.create).toHaveLength(1);
    const [row] = p.create;
    expect(row!.phone).toBe('0510103375');
    expect(row!.payload.assigned_agent).toBe('user-faisal');
    expect(row!.payload.order_id).toBe('451351');
    // `solved`, the live word for a handled complaint (owner, 2026-10-07).
    expect(row!.payload.status).toBe('solved');
    // The branch is FROZEN onto the ticket, so editing the store later cannot
    // rewrite what this row reports.
    expect(row!.payload.store).toBe('store-1');
    expect(p.unmatchedStores).toBe(0);
    expect(p.newContacts).toBe(1);
  });

  it('keeps a row whose branch is not in the store master, and counts it', () => {
    // A missing branch is a gap in the master, not a reason to lose a real
    // complaint — it imports and reports as "Not mapped".
    const p = plan(
      `${HEADER}\n2026-01-01,10:00,OKA,OKA-013 Nowhere Plaza,Pickup,Accuracy,0510103375,x,1,Faisal`,
    );
    expect(p.create).toHaveLength(1);
    expect(p.unmatchedStores).toBe(1);
    expect(p.create[0]!.payload.store).toBeUndefined();
  });

  it('refuses a row with no usable date, and says which line', () => {
    // Every cut in this report is by date, so a dateless row would exist and
    // appear nowhere at all.
    const p = plan(
      `${HEADER}\n,,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,x,1,Faisal`,
    );
    expect(p.create).toHaveLength(0);
    expect(p.skipped).toEqual([{ line: 2, reason: 'no usable date' }]);
  });

  it('imports the ticket but withholds the contact when the number is corrupt', () => {
    // An 18-digit paste really was in the sheet; normalizePhone passes it
    // through because it cannot tell corrupt from unfamiliar.
    const p = plan(
      `${HEADER}\n2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,508317417558378794,x,1,Faisal`,
    );
    expect(p.create).toHaveLength(1);
    expect(p.create[0]!.phone).toBeNull();
    expect(p.create[0]!.payload.contact).toBeUndefined();
    expect(p.newContacts).toBe(0);
  });

  it('links an existing customer rather than making a second one', () => {
    const p = plan(
      `${HEADER}\n2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,x,1,Faisal`,
      { contactByPhone: new Map([['0510103375', 'contact-9']]) },
    );
    expect(p.create[0]!.payload.contact).toBe('contact-9');
    expect(p.newContacts).toBe(0);
  });

  it('skips rows already in the database', () => {
    const line =
      '2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,Late,7,Faisal';
    const first = plan(`${HEADER}\n${line}`);
    const ref = first.create[0]!.ref;

    const second = plan(`${HEADER}\n${line}`, { existing: new Set([ref]) });
    expect(second.create).toHaveLength(0);
    expect(second.duplicates).toBe(1);
    expect(second.alreadyLoaded).toBe(1);
    expect(second.repeatedInSheet).toEqual([]);
  });

  it('skips a row repeated WITHIN the same sheet', () => {
    const line =
      '2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,Late,7,Faisal';
    const p = plan(`${HEADER}\n${line}\n${line}`);
    expect(p.create).toHaveLength(1);
    expect(p.duplicates).toBe(1);
    // Named as the sheet's own repeat, with both lines, not as "already loaded".
    expect(p.alreadyLoaded).toBe(0);
    expect(p.repeatedInSheet).toEqual([{ line: 3, firstLine: 2 }]);
  });

  /*
   * EMA-43: 9 pairs in the real history sheet shared time, order and
   * description and differed only in agent / coupon / compensation — and the
   * second of each was dropped as a duplicate. They are different complaints.
   */
  it('keeps two rows that differ only in the agent', () => {
    const a =
      '2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,Late,7,Faisal';
    const b = a.replace(/Faisal$/, 'Sara');
    const p = plan(`${HEADER}\n${a}\n${b}`, {
      agentByName: new Map([
        ['faisal', 'u-faisal'],
        ['sara', 'u-sara'],
      ]),
    });
    expect(p.create).toHaveLength(2);
    expect(p.duplicates).toBe(0);
  });

  it('counts one new contact when the same customer complains twice', () => {
    const p = plan(
      `${HEADER}\n` +
        '2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,First,1,Faisal\n' +
        '2026-02-02,11:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,Second,2,Faisal',
    );
    expect(p.create).toHaveLength(2);
    expect(p.newContacts).toBe(1);
  });
});

describe('ticketIdentity', () => {
  const base = {
    complaint_date: '2026-01-01T10:00:00.000Z',
    order_id: '451351',
    description: 'Wrong drink',
  };
  it('is stable for the same complaint and different for another', () => {
    const a = ticketIdentity(base);
    expect(a).toBe(ticketIdentity({ ...base }));
    expect(a).not.toBe(ticketIdentity({ ...base, order_id: '451352' }));
  });

  /* A stored ticket read back must match the row about to be written. */
  it('ignores how the database spells the same instant and number', () => {
    expect(ticketIdentity({ ...base, coupon_value: 9 })).toBe(
      ticketIdentity({ ...base, complaint_date: '2026-01-01T10:00:00', coupon_value: '9.00000' }),
    );
  });

  it('tells apart complaints that differ only in coupon or compensation', () => {
    const a = ticketIdentity({ ...base, coupon_code: 'OPS-1', compensation: 'Coupon' });
    expect(a).not.toBe(ticketIdentity({ ...base, coupon_code: 'OPS-2', compensation: 'Coupon' }));
    expect(a).not.toBe(ticketIdentity({ ...base, coupon_code: 'OPS-1', compensation: 'Refund' }));
  });
});

describe('runImport', () => {
  const basePlan = (): ImportPlan =>
    plan(
      `${HEADER}\n2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,x,1,Faisal`,
    );

  it('creates the contact BEFORE the ticket, and links it', async () => {
    const order: string[] = [];
    const p = basePlan();
    const createContacts = vi.fn(async (phones: string[]) => {
      order.push('contacts');
      return new Map(phones.map((ph) => [ph, `contact-${ph}`]));
    });
    const createTickets = vi.fn(async (payloads: Array<Record<string, unknown>>) => {
      order.push('tickets');
      // The link must already be resolved by the time the ticket is written.
      expect(payloads[0]!.contact).toBe('contact-0510103375');
    });

    const res = await runImport(p, { createContacts, createTickets }, new Map());

    expect(order).toEqual(['contacts', 'tickets']);
    expect(res).toEqual({
      created: 1,
      contactsCreated: 1,
      failed: 0,
      failures: [],
      contactsFailed: 0,
    });
  });

  it('retries singly so one bad row does not cost the whole batch', async () => {
    const p = plan(
      `${HEADER}\n` +
        '2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,good,1,Faisal\n' +
        '2026-01-02,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103376,bad,2,Faisal',
    );
    const createTickets = vi.fn(async (payloads: Array<Record<string, unknown>>) => {
      if (payloads.length > 1) throw new Error('batch rejected');
      if (payloads[0]!.description === 'bad') throw new Error('row rejected');
    });

    const res = await runImport(
      p,
      {
        createContacts: async (phones) => new Map(phones.map((ph) => [ph, `c-${ph}`])),
        createTickets,
      },
      new Map(),
    );

    expect(res.created).toBe(1);
    expect(res.failed).toBe(1);
    // EMA-43: the refused row is NAMED, with the server's reason.
    expect(res.failures).toEqual([{ line: 3, reason: 'row rejected' }]);
  });

  it("reads a Directus rejection's own message, not [object Object]", async () => {
    const res = await runImport(
      basePlan(),
      {
        createContacts: async (phones) => new Map(phones.map((ph) => [ph, `c-${ph}`])),
        createTickets: async () => {
          throw { errors: [{ message: 'Value for field "store" is invalid' }] };
        },
      },
      new Map(),
    );
    expect(res.failures).toEqual([{ line: 2, reason: 'Value for field "store" is invalid' }]);
  });

  it('a failed contact batch no longer aborts the import', async () => {
    const p = plan(
      `${HEADER}\n` +
        '2026-01-01,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103375,a,1,Faisal\n' +
        '2026-01-02,10:00,LCP,LCP-038 Yarmouk Plaza,Delivery,Accuracy,0510103376,b,2,Faisal',
    );
    const createContacts = vi.fn(async (phones: string[]) => {
      if (phones.length > 1 || phones[0] === '0510103376') throw new Error('contact refused');
      return new Map(phones.map((ph) => [ph, `c-${ph}`]));
    });
    const written: Array<Record<string, unknown>> = [];
    const res = await runImport(
      p,
      { createContacts, createTickets: async (ps) => void written.push(...ps) },
      new Map(),
    );
    expect(res.created).toBe(2);
    expect(res.contactsCreated).toBe(1);
    expect(res.contactsFailed).toBe(1);
    // The ticket whose customer could not be created still lands, unlinked.
    expect(written.find((w) => w.description === 'b')!.contact).toBeUndefined();
  });

  it('writes nothing when there is nothing to write', async () => {
    const createTickets = vi.fn();
    const createContacts = vi.fn();
    const empty = plan(`${HEADER}\n`);

    const res = await runImport(empty, { createContacts, createTickets }, new Map());

    expect(createTickets).not.toHaveBeenCalled();
    expect(createContacts).not.toHaveBeenCalled();
    expect(res).toEqual({
      created: 0,
      contactsCreated: 0,
      failed: 0,
      failures: [],
      contactsFailed: 0,
    });
  });
});
