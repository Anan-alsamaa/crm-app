import { describe, expect, it } from 'vitest';
import { rowsToCsv } from '../src/processors/reports.js';

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
