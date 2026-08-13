import { describe, it, expect } from 'vitest';
import {
  buildComplaintsTemplate,
  buildWorkbook,
  parseTicketsCells,
  readXlsxRows,
  excelSerialToIsoDate,
  excelSerialToTime,
} from '../src/index.js';

/**
 * The closed loop the template feature promises: a workbook OUR writer builds
 * is readable by OUR reader, and its header row maps straight back through the
 * import aliases. If this breaks, "fill the template and import it back"
 * breaks — silently, at the person least equipped to debug it.
 */
const INPUT = {
  lists: {
    complaint_type: ['Missing item', 'Late order'],
    service_type: ['Delivery', 'Pickup'],
    complaint_source: ['WeCare Channels'],
    communication_method: ['Comp. WhatsApp'],
    compensation: ['Initial', 'Compensated'],
  },
  restaurants: ['LCP-032 Masief Plaza', 'LCP-004 Nakhil Plaza'],
  brands: ['Casa Pasta'],
  cities: ['Riyadh 1'],
  agents: ['Amjad', 'Yara'],
  statuses: ['new', 'open', 'pending', 'resolved', 'closed'],
};

describe('template → workbook → reader → parser round-trip', () => {
  it('produces a Complaints sheet whose headers the importer maps completely', async () => {
    const sheets = buildComplaintsTemplate(INPUT);
    const rows = await readXlsxRows(await buildWorkbook(sheets).arrayBuffer());
    const parsed = parseTicketsCells(rows);
    // Every template header must round-trip through the alias table — an
    // unmapped header is a column the ops team fills that the import discards.
    expect(parsed.unmappedHeaders).toEqual([]);
  });

  it('keeps the Lists sheet hidden and the dropdowns pointed at it', () => {
    const sheets = buildComplaintsTemplate(INPUT);
    const lists = sheets.find((s) => s.name === 'Lists')!;
    expect(lists.hidden).toBe(true);
    const complaints = sheets.find((s) => s.name === 'Complaints')!;
    expect(complaints.validations!.length).toBeGreaterThanOrEqual(8);
    for (const v of complaints.validations!) {
      expect(v.formula).toMatch(/^Lists!\$[A-Z]+\$2:\$[A-Z]+\$\d+$/);
    }
  });

  it('reads back typed data rows exactly, including shared values and numbers', async () => {
    const sheets = buildComplaintsTemplate(INPUT);
    // Fill BY HEADER, not by position — the test must not depend on column
    // order any more than a person filling the template does.
    const headers = sheets[0]!.columns.map((c) => c.header);
    const fill: Record<string, string | number> = {
      Date: '2026-08-13',
      Time: '19:11',
      Brand: 'Casa Pasta',
      City: 'Riyadh 1',
      'Restaurant name': 'LCP-032 Masief Plaza',
      'Service type': 'Delivery',
      'Complaint type': 'Missing item',
      'Customer mobile': '0551234567',
      'Complaint description': 'Two burgers missing',
      'Complaint source': 'WeCare Channels',
      'Order amount': 120.5,
      'Order number': '946641',
      'Communication method': 'Comp. WhatsApp',
      'Coupon value': 25,
      'Complaint status': 'new',
      Agent: 'Amjad',
      Compensation: 'Initial',
    };
    sheets[0]!.rows = [headers.map((h) => fill[h] ?? '')];
    const rows = await readXlsxRows(await buildWorkbook(sheets).arrayBuffer());
    const parsed = parseTicketsCells(rows);
    expect(parsed.rows).toHaveLength(1);
    const r = parsed.rows[0]!;
    expect(r.complaintType).toBe('Missing item');
    expect(r.customerMobile).toBe('0551234567');
    expect(r.orderAmount).toBe('120.5');
    expect(r.orderNumber).toBe('946641');
    expect(r.agent).toBe('Amjad');
  });

  it('converts Excel serial dates and times when they land in date columns', () => {
    // 2026-08-13 is serial 46247 in the 1900 system; 19:11 is .7993 of a day.
    expect(excelSerialToIsoDate(46247)).toBe('2026-08-13');
    expect(excelSerialToTime(46247 + 19 / 24 + 11 / (24 * 60))).toBe('19:11');
    const parsed = parseTicketsCells([
      ['Date', 'Time', 'Restaurant Name'],
      [46247, 0.7993055555, 'LCP-032 Masief Plaza'],
    ]);
    expect(parsed.rows[0]!.date).toBe('2026-08-13');
    expect(parsed.rows[0]!.time).toBe('19:11');
  });

  it('rejects a file that is not a zip with a named error', async () => {
    await expect(
      readXlsxRows(new TextEncoder().encode('not an xlsx').buffer as ArrayBuffer),
    ).rejects.toThrow('not_a_zip');
  });
});
