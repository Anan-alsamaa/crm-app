import { describe, it, expect } from 'vitest';
import { buildStoreIndex, matchStore, type StoreRecord } from '@yiji/shared-types';
import {
  isBlankCell,
  parseTicketsCsv,
  ticketPayloadFromCsvRow,
  toComplaintDate,
  toNumberCell,
} from '../src/import-csv.js';

/**
 * The rule is "put each column where it belongs". The work is being forgiving
 * about how a header is spelled and how a value is typed, because these files
 * come out of Excel through several pairs of hands.
 */

const HEADER =
  'date,time,chain,area,brand,city,restaurant_name,service_type,complaint_type,customer_mobile,complaint_description,response_desc,complaint_source,order_amount,order_number,communication_method,coupon_code,coupon_value,coupon_percent,complaint_status,restaurant_manager_id,agent,compensation';

describe('parseTicketsCsv', () => {
  it('puts each column under the right field', () => {
    const { rows } = parseTicketsCsv(
      [
        HEADER,
        "2026-03-14,19:11,Medhat Sayed,Mo'men,LCP,Riyadh,LCP-041 Masief Plaza,Delivery,Missing item,0501234567,One pasta missing,Apologised,WeCare Channels,102.85,946641,Comp. WhatsApp,OPS - 46,25,,Closed - Customer Satisfied,,Amjad,Compensated",
      ].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-03-14',
      time: '19:11',
      restaurantName: 'LCP-041 Masief Plaza',
      complaintType: 'Missing item',
      customerMobile: '0501234567',
      orderNumber: '946641',
      compensation: 'Compensated',
    });
  });

  it('accepts the Title Case headers the sheet actually uses', () => {
    const { rows, unmappedHeaders } = parseTicketsCsv(
      [
        'Date,Restaurant Name,Customer Mobile,Order Number',
        '2026-03-14,LCP-041,0501234567,946641',
      ].join('\n'),
    );
    expect(unmappedHeaders).toEqual([]);
    expect(rows[0]).toMatchObject({ restaurantName: 'LCP-041', customerMobile: '0501234567' });
  });

  it('keeps a description that contains commas in one cell', () => {
    // The reason this is not line.split(','): a naive split shifts every later
    // column one place left and nothing errors.
    const { rows } = parseTicketsCsv(
      ['date,complaint_description,agent', '2026-03-14,"Cold, late, and wrong",Amjad'].join('\n'),
    );
    expect(rows[0]!.complaintDescription).toBe('Cold, late, and wrong');
    expect(rows[0]!.agent).toBe('Amjad');
  });

  it('handles a quoted description that spans lines', () => {
    const { rows } = parseTicketsCsv(
      ['date,complaint_description', '2026-03-14,"line one\nline two"'].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.complaintDescription).toContain('line two');
  });

  it('treats the sheet\'s "-" as empty rather than importing a hyphen', () => {
    const { rows } = parseTicketsCsv(
      ['date,order_number,order_amount', '2026-03-14,-,-'].join('\n'),
    );
    expect(rows[0]!.orderNumber).toBeUndefined();
    expect(rows[0]!.orderAmount).toBeUndefined();
  });

  it('reports headers it could not place instead of dropping them silently', () => {
    const { unmappedHeaders } = parseTicketsCsv(
      ['date,wibble,agent', '2026-03-14,x,Amjad'].join('\n'),
    );
    expect(unmappedHeaders).toEqual(['wibble']);
  });

  it("skips Excel's trailing blank rows, and says it did", () => {
    const { rows, skipped } = parseTicketsCsv([HEADER, ',,,,,,,,,,,,,,,,,,,,,,', ''].join('\n'));
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe('empty row');
  });

  it('survives a file with only a header', () => {
    expect(parseTicketsCsv(HEADER).rows).toEqual([]);
  });

  it('survives an empty file', () => {
    expect(parseTicketsCsv('')).toEqual({ rows: [], skipped: [], unmappedHeaders: [] });
  });

  it('tolerates a UTF-8 BOM, which Excel writes', () => {
    const { rows } = parseTicketsCsv('﻿date,agent\n2026-03-14,Amjad');
    expect(rows[0]!.date).toBe('2026-03-14');
  });
});

describe('toComplaintDate', () => {
  it("combines the sheet's separate date and time columns", () => {
    const iso = toComplaintDate('2026-03-14', '19:11')!;
    const d = new Date(iso);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth() + 1).toBe(3);
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(19);
    expect(d.getMinutes()).toBe(11);
  });

  it('accepts day/month/year, which is how Excel exports here', () => {
    const d = new Date(toComplaintDate('14/03/2026', '09:05')!);
    expect(d.getMonth() + 1).toBe(3);
    expect(d.getDate()).toBe(14);
  });

  it('accepts HH:MM:SS as well as H:MM', () => {
    expect(new Date(toComplaintDate('2026-03-14', '09:05:33')!).getHours()).toBe(9);
  });

  it('falls back to midnight rather than losing the row over a broken clock', () => {
    // The historical file has one time cell of "#################".
    const d = new Date(toComplaintDate('2026-03-14', '#################')!);
    expect(d.getHours()).toBe(0);
    expect(d.getDate()).toBe(14);
  });

  it('is null when there is no usable date at all', () => {
    expect(toComplaintDate(undefined, '19:11')).toBeNull();
    expect(toComplaintDate('not a date', '19:11')).toBeNull();
  });
});

describe('toNumberCell', () => {
  it('reads the amounts the sheet actually contains', () => {
    expect(toNumberCell('102.85')).toBe(102.85);
    expect(toNumberCell('102.85 SR')).toBe(102.85);
    expect(toNumberCell('1,200')).toBe(1200);
  });

  it("is null for the sheet's placeholders", () => {
    for (const v of ['-', '', '  ', undefined, 'N/A']) expect(toNumberCell(v)).toBeNull();
  });
});

describe('isBlankCell', () => {
  it('knows the several ways this sheet writes "nothing"', () => {
    for (const v of ['', '  ', '-', '—', 'N/A', 'n/a']) expect(isBlankCell(v)).toBe(true);
    expect(isBlankCell('0')).toBe(false);
  });
});

describe('ticketPayloadFromCsvRow', () => {
  const STORE: StoreRecord = {
    id: 's1',
    code: 'LCP-041',
    name: 'Masief Plaza',
    city: 'Riyadh',
    areaManager: 'Ahmed Samir',
    chainManager: 'Medhat Sayed',
    brandCode: 'LCP',
    brandName: 'Casa Pasta',
    yijiRestaurantId: null,
  };
  const idx = buildStoreIndex([STORE]);
  const match = matchStore(idx, { restaurantName: 'LCP-041 Masief Plaza' });
  const base = { store: match, capturedAt: '2026-08-12T00:00:00.000Z' };

  it('maps each column onto its ticket field', () => {
    const p = ticketPayloadFromCsvRow(
      {
        complaintType: 'Missing item',
        complaintDescription: 'One pasta missing',
        responseDesc: 'Apologised',
        serviceType: 'Delivery',
        complaintSource: 'WeCare Channels',
        communicationMethod: 'Comp. WhatsApp',
        compensation: 'Compensated',
        couponCode: 'OPS - 46',
        couponValue: '25',
      },
      base,
    );
    expect(p).toMatchObject({
      subject: 'Missing item',
      description: 'One pasta missing',
      response_desc: 'Apologised',
      service_type: 'Delivery',
      complaint_source: 'WeCare Channels',
      communication_method: 'Comp. WhatsApp',
      compensation: 'Compensated',
      coupon_code: 'OPS - 46',
      coupon_value: 25,
    });
  });

  it('imports as closed — these are handled complaints, not new work', () => {
    // Every historical row is "Closed - Customer Satisfied". Importing them as
    // open would drop 50 fake items into somebody's queue.
    expect(ticketPayloadFromCsvRow({}, base).status).toBe('closed');
  });

  it('freezes the branch attribution, like a ticket raised in the portal', () => {
    const p = ticketPayloadFromCsvRow({ restaurantName: 'LCP-041 Masief Plaza' }, base) as {
      store: string;
      store_snapshot: { areaManager: string };
    };
    expect(p.store).toBe('s1');
    expect(p.store_snapshot.areaManager).toBe('Ahmed Samir');
  });

  it('always has a subject, because the sheet has no subject column', () => {
    expect(ticketPayloadFromCsvRow({}, base).subject).toBe('Imported complaint');
    expect(ticketPayloadFromCsvRow({ complaintDescription: 'Cold food' }, base).subject).toBe(
      'Cold food',
    );
  });

  it('carries the order only when the sheet had one', () => {
    expect(ticketPayloadFromCsvRow({}, base).order_snapshot).toBeUndefined();
    const p = ticketPayloadFromCsvRow(
      { orderNumber: '946641', orderAmount: '102.85 SR' },
      base,
    ) as {
      order_snapshot: { orderId: string; total: number };
    };
    expect(p.order_snapshot).toMatchObject({ orderId: '946641', total: 102.85 });
  });

  it('omits links it was not given rather than writing nulls into relations', () => {
    const p = ticketPayloadFromCsvRow({}, base);
    for (const k of ['contact', 'vendor', 'assigned_agent', 'complaint_date']) {
      expect(p).not.toHaveProperty(k);
    }
  });

  it('sets the complaint date when the caller resolved one', () => {
    const p = ticketPayloadFromCsvRow({}, { ...base, complaintDate: '2026-03-14T19:11:00.000Z' });
    expect(p.complaint_date).toBe('2026-03-14T19:11:00.000Z');
  });
});

describe('the imported order snapshot is renderable', () => {
  const match = matchStore(buildStoreIndex([]), { restaurantName: 'X' });
  const base = { store: match, capturedAt: 'now' };

  it('carries every field the order card reads, not just what the sheet had', () => {
    // The card does `order.items.reduce(...)` and formats `total`; a partial
    // object crashed the ticket page with "Something went wrong".
    const p = ticketPayloadFromCsvRow({ orderNumber: '946641' }, base) as {
      order_snapshot: Record<string, unknown>;
    };
    const snap = p.order_snapshot;
    expect(Array.isArray(snap.items)).toBe(true);
    expect(typeof snap.total).toBe('number');
    for (const k of ['orderId', 'status', 'currency', 'placedAt']) {
      expect(snap[k]).toBeDefined();
    }
  });

  it('never emits a null total, which the card cannot format', () => {
    const p = ticketPayloadFromCsvRow({ orderNumber: '1' }, base) as {
      order_snapshot: { total: number };
    };
    expect(p.order_snapshot.total).toBe(0);
  });
});
