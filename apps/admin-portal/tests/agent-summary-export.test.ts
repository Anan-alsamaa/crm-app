import { describe, expect, it } from 'vitest';
import { formatDuration, type AgentPerformanceRow } from '@yiji/reports';
import { agentSummaryExport } from '../src/features/performance/agent-summary-export.js';

/**
 * Owner, 25 Nov 2026: "the data on the portal is correct, but in the excel is
 * wrong". The file must carry the "Totals per agent" table as shown.
 */
const labels = {
  agent: 'Agent',
  chats: 'Chats',
  noReplyYet: 'No reply yet',
  commonChats: 'Common chats taken',
  firstResponse: 'First response',
  solved: 'Solved',
  timeToSolve: 'Time to solve (avg)',
  rating: 'Customer rating',
};

const row = (over: Partial<AgentPerformanceRow>): AgentPerformanceRow =>
  ({
    agentId: 'a1',
    agentName: 'Sultan',
    chats: 53,
    answered: 58, // first replies SENT, incl. chats later handed on: NOT a page column
    unanswered: 0,
    ownChats: 50,
    commonChats: 31,
    solved: 53,
    avgFirstResponseSec: 288.9118103,
    medianFirstResponseSec: 133.2675,
    avgTimeToSolveSec: 1175.57,
    medianTimeToSolveSec: 774.632,
    ...over,
  }) as AgentPerformanceRow;

describe('Totals per agent export = the table on screen', () => {
  it('has the page columns in the page order, and no column the page lacks', () => {
    const { header } = agentSummaryExport([], new Map(), labels);
    expect(header).toEqual([
      'Agent',
      'Chats',
      'No reply yet',
      'Common chats taken',
      'First response',
      'Solved',
      'Time to solve (avg)',
      'Customer rating',
    ]);
    expect(header.join(',')).not.toMatch(/Answered|median|seconds/i);
  });

  it('writes the values the page shows (durations formatted, rating to one decimal)', () => {
    const { body } = agentSummaryExport(
      [
        row({}),
        row({ agentId: 'a2', agentName: 'Amjad', avgFirstResponseSec: null, unanswered: 1 }),
      ],
      new Map([['a1', { avg: 2.83, n: 6 }]]),
      labels,
    );
    expect(body[0]).toEqual([
      'Sultan',
      53,
      0,
      31,
      formatDuration(288.9118103),
      53,
      formatDuration(1175.57),
      '2.8',
    ]);
    expect(body[0]?.[4]).toBe('4m 49s');
    expect(body[0]?.[6]).toBe('19m 36s');
    // No reply yet, no first response, nobody rated: blank, never 0 or "NaN".
    expect(body[1]?.[2]).toBe(1);
    expect(body[1]?.[4]).toBe('');
    expect(body[1]?.[7]).toBe('');
  });

  it('never exports the Answered count, which can exceed Chats', () => {
    const { body } = agentSummaryExport([row({})], new Map(), labels);
    expect(body[0]).not.toContain(58);
  });
});
