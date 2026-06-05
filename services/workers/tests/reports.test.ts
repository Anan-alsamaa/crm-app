import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import {
  rowsToCsv,
  reportAgentProductivity,
  reportCsat,
  reportVendorActivity,
  type ReportsDeps,
} from '../src/processors/reports.js';

/** Fake Directus whose `request` returns a fixed dataset regardless of query. */
function depsReturning(data: unknown[]): ReportsDeps {
  return {
    directus: { request: async () => data } as unknown as ReportsDeps['directus'],
    mail: { send: async () => undefined },
    logger: { warn: () => undefined } as unknown as Logger,
  };
}
const toMap = (rows: string[][]) => new Map(rows.slice(1).map((r) => [r[0], r.slice(1)]));

describe('reports CSV rendering', () => {
  it('renders simple rows with CRLF line endings', () => {
    const csv = rowsToCsv([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(csv).toBe('"a","b","c"\r\n"1","2","3"');
  });

  it('escapes double quotes by doubling', () => {
    expect(rowsToCsv([['he said "hi"']])).toBe('"he said ""hi"""');
  });

  it('quotes fields containing commas', () => {
    expect(rowsToCsv([['Last, First']])).toBe('"Last, First"');
  });

  it('preserves empty cells', () => {
    expect(rowsToCsv([['a', '', 'c']])).toBe('"a","","c"');
  });
});

describe('reportAgentProductivity', () => {
  it('aggregates assigned/resolved + resolution rate per agent', async () => {
    const t = (assigned_agent: string, status: string, created?: string, resolved?: string) => ({
      id: Math.random().toString(),
      assigned_agent,
      status,
      date_created: created ?? null,
      resolved_at: resolved ?? null,
    });
    const deps = depsReturning([
      t('a1', 'closed', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'), // 60 min
      t('a1', 'open'),
      t('a2', 'resolved', '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'), // 30 min
    ]);
    const { rows } = await reportAgentProductivity(deps, {});
    const m = toMap(rows);
    expect(m.get('a1')).toEqual(['2', '1', '50', '60']); // 1 of 2 resolved, 60min
    expect(m.get('a2')).toEqual(['1', '1', '100', '30']);
  });
});

describe('reportCsat', () => {
  it('computes count, average and score distribution', async () => {
    const deps = depsReturning([{ score: 5 }, { score: 4 }, { score: 5 }, { score: null }]);
    const { rows, rowCount } = await reportCsat(deps, {});
    const m = toMap(rows);
    expect(rowCount).toBe(3);
    expect(m.get('responses')).toEqual(['3']);
    expect(m.get('average_score')).toEqual(['4.67']);
    expect(m.get('score_5')).toEqual(['2']);
    expect(m.get('score_4')).toEqual(['1']);
    expect(m.get('score_1')).toEqual(['0']);
  });
});

describe('reportVendorActivity', () => {
  it('counts conversations + open/resolved per vendor', async () => {
    const deps = depsReturning([
      { vendor: 'v1', status: 'open' },
      { vendor: 'v1', status: 'closed' },
      { vendor: 'v2', status: 'resolved' },
      { vendor: null, status: 'open' },
    ]);
    const { rows } = await reportVendorActivity(deps, {});
    const m = toMap(rows);
    expect(m.get('v1')).toEqual(['2', '1', '1']);
    expect(m.get('v2')).toEqual(['1', '0', '1']);
    expect(m.get('unknown')).toEqual(['1', '1', '0']);
  });
});
