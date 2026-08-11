import { describe, it, expect } from 'vitest';
import {
  splitCsvLine,
  parseCsv,
  parseStoresCsv,
  splitStoreCode,
} from '../src/features/restaurants/csv.js';

describe('splitCsvLine', () => {
  it('keeps commas that live inside quoted fields', () => {
    // The whole reason this exists: a naive split shifts every later column
    // left, putting the city into the manager cell with no error.
    expect(splitCsvLine('"Riyadh, Al Nakheel",Ahmed Samir,LCP')).toEqual([
      'Riyadh, Al Nakheel',
      'Ahmed Samir',
      'LCP',
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(splitCsvLine('"He said ""hi""",x')).toEqual(['He said "hi"', 'x']);
  });

  it('handles empty trailing fields', () => {
    expect(splitCsvLine('a,,c,')).toEqual(['a', '', 'c', '']);
  });
});

describe('parseCsv', () => {
  it('strips a BOM from an Excel export', () => {
    const { header } = parseCsv('﻿Restaurant,City\nX,Y');
    expect(header).toEqual(['Restaurant', 'City']);
  });

  it('accepts tab-delimited text (Excel "Text (tab delimited)")', () => {
    const { header, rows } = parseCsv('Restaurant\tCity\nLCP-002 Marina Mall 2\tKhobar');
    expect(header).toEqual(['Restaurant', 'City']);
    expect(rows[0]).toEqual(['LCP-002 Marina Mall 2', 'Khobar']);
  });

  it('ignores blank lines', () => {
    const { rows } = parseCsv('A,B\n\n1,2\n\n');
    expect(rows).toHaveLength(1);
  });
});

describe('splitStoreCode', () => {
  it('separates the ops store code from the branch name', () => {
    expect(splitStoreCode('LCP-002 Marina Mall 2')).toEqual({
      code: 'LCP-002',
      name: 'Marina Mall 2',
    });
    expect(splitStoreCode('CND-001 Reine Plaza')).toEqual({
      code: 'CND-001',
      name: 'Reine Plaza',
    });
  });

  it('leaves an uncoded name alone', () => {
    expect(splitStoreCode('Marina Mall 2')).toEqual({ code: null, name: 'Marina Mall 2' });
  });
});

describe('parseStoresCsv', () => {
  const SHEET = [
    'Restaurant,Area Manager,Chain Manager,Brand,City',
    'CND-001 Reine Plaza,Aly AbdulRahman,Aly AbdulRahman,CND Express,Khobar',
    'LCP-002 Marina Mall 2,Medhat Saeed,Mo’men Elsharkawy,LCP,Dammam',
  ].join('\n');

  it('maps the operations sheet layout', () => {
    const { rows, skipped, unmappedHeaders } = parseStoresCsv(SHEET);
    expect(skipped).toEqual([]);
    expect(unmappedHeaders).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      code: 'CND-001',
      name: 'Reine Plaza',
      city: 'Khobar',
      areaManager: 'Aly AbdulRahman',
      chainManager: 'Aly AbdulRahman',
      brandCode: 'CND Express',
      yijiRestaurantId: null,
    });
    expect(rows[1]!.code).toBe('LCP-002');
    expect(rows[1]!.city).toBe('Dammam');
  });

  it('is case and spacing insensitive about headers', () => {
    const { rows } = parseStoresCsv('  RESTAURANT , city \nLCP-003 Nakheel,Riyadh');
    expect(rows[0]!.name).toBe('Nakheel');
    expect(rows[0]!.city).toBe('Riyadh');
  });

  it('picks up an optional Yiji restaurant id column', () => {
    const { rows } = parseStoresCsv('Restaurant,Yiji Restaurant ID\nLCP-004 X,312');
    expect(rows[0]!.yijiRestaurantId).toBe('312');
  });

  it('skips nameless rows instead of importing blanks', () => {
    // A store with no name can never match an order — importing it would just
    // create invisible dead data.
    const { rows, skipped } = parseStoresCsv('Restaurant,City\n,Riyadh\nLCP-005 Y,Jeddah');
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ line: 2, reason: 'no restaurant name' }]);
  });

  it('reports headers it could not place rather than dropping them silently', () => {
    const { unmappedHeaders } = parseStoresCsv('Restaurant,Nonsense\nLCP-006 Z,q');
    expect(unmappedHeaders).toEqual(['Nonsense']);
  });

  it('handles an empty document', () => {
    expect(parseStoresCsv('')).toEqual({ rows: [], skipped: [], unmappedHeaders: [] });
  });
});
