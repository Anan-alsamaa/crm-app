import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { reportCsat, type ReportsDeps } from '../src/processors/reports.js';

/**
 * Focused edge-case coverage for the CSAT scoring aggregation
 * (`reportCsat` in src/processors/reports.ts). The happy path is covered in
 * reports.test.ts; this file pins the branch behaviour that drives the CSAT
 * metric shown in the admin reports/dashboard:
 *   - out-of-range / non-numeric scores are ignored
 *   - the empty-dataset average is "0" (the `n ? … : '0'` branch)
 *   - the full 1..5 distribution is always emitted
 *   - rowCount reflects valid responses (n), not the CSV row count
 *
 * Mirrors the convention in reports.test.ts: a fake Directus whose `request`
 * returns a fixed dataset, and a `toMap` helper that indexes the metric rows.
 */

/** Fake Directus whose `request` returns a fixed dataset regardless of query. */
function depsReturning(data: unknown[]): ReportsDeps {
  return {
    directus: { request: async () => data } as unknown as ReportsDeps['directus'],
    mail: { send: async () => undefined },
    logger: { warn: () => undefined } as unknown as Logger,
  };
}
const toMap = (rows: string[][]) => new Map(rows.slice(1).map((r) => [r[0], r.slice(1)]));

describe('reportCsat — scoring edge cases', () => {
  it('ignores scores outside the 1..5 range and non-numeric scores', async () => {
    const deps = depsReturning([
      { score: 0 }, // below range — ignored
      { score: 6 }, // above range — ignored
      { score: -3 }, // negative — ignored
      { score: 3.5 }, // valid number in range, counted (no integer guard here)
      { score: '4' }, // string, not a number — ignored
      { score: null }, // null — ignored
      { score: 4 }, // valid
    ]);
    const { rows, rowCount } = await reportCsat(deps, {});
    const m = toMap(rows);
    // Only 3.5 and 4 are counted: n = 2, sum = 7.5, avg = 3.75.
    expect(rowCount).toBe(2);
    expect(m.get('responses')).toEqual(['2']);
    expect(m.get('average_score')).toEqual(['3.75']);
    // 3.5 does not land in any integer score bucket; 4 lands in score_4.
    expect(m.get('score_4')).toEqual(['1']);
    expect(m.get('score_1')).toEqual(['0']);
    expect(m.get('score_2')).toEqual(['0']);
    expect(m.get('score_3')).toEqual(['0']);
    expect(m.get('score_5')).toEqual(['0']);
  });

  it('reports zero responses and a "0" average for an empty dataset', async () => {
    const deps = depsReturning([]);
    const { rows, rowCount } = await reportCsat(deps, {});
    const m = toMap(rows);
    expect(rowCount).toBe(0);
    expect(m.get('responses')).toEqual(['0']);
    // The `n ? (sum / n).toFixed(2) : '0'` branch — plain '0', not '0.00'.
    expect(m.get('average_score')).toEqual(['0']);
    // The 1..5 distribution rows are still present and all zero.
    for (let s = 1; s <= 5; s += 1) {
      expect(m.get(`score_${s}`)).toEqual(['0']);
    }
  });

  it('reports zero responses when every score is out of range', async () => {
    const deps = depsReturning([{ score: 0 }, { score: 6 }, { score: null }]);
    const { rows, rowCount } = await reportCsat(deps, {});
    const m = toMap(rows);
    expect(rowCount).toBe(0);
    expect(m.get('responses')).toEqual(['0']);
    expect(m.get('average_score')).toEqual(['0']);
  });

  it('builds the full 1..5 distribution and a rounded 2dp average', async () => {
    const deps = depsReturning([
      { score: 1 },
      { score: 2 },
      { score: 3 },
      { score: 3 },
      { score: 4 },
      { score: 5 },
    ]);
    const { rows, rowCount } = await reportCsat(deps, {});
    const m = toMap(rows);
    expect(rowCount).toBe(6);
    expect(m.get('responses')).toEqual(['6']);
    // (1+2+3+3+4+5)/6 = 3.0 -> toFixed(2) = '3.00'.
    expect(m.get('average_score')).toEqual(['3.00']);
    expect(m.get('score_1')).toEqual(['1']);
    expect(m.get('score_2')).toEqual(['1']);
    expect(m.get('score_3')).toEqual(['2']);
    expect(m.get('score_4')).toEqual(['1']);
    expect(m.get('score_5')).toEqual(['1']);
  });

  it('emits exactly the responses + average + five distribution rows (plus header)', async () => {
    const deps = depsReturning([{ score: 5 }]);
    const { rows } = await reportCsat(deps, {});
    // header + responses + average_score + score_1..score_5 = 8 rows total.
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual(['metric', 'value']);
    expect(rows.map((r) => r[0])).toEqual([
      'metric',
      'responses',
      'average_score',
      'score_1',
      'score_2',
      'score_3',
      'score_4',
      'score_5',
    ]);
  });
});
