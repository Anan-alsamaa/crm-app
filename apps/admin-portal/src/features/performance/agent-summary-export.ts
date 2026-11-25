import { formatDuration, type AgentPerformanceRow } from '@yiji/reports';

/**
 * THE "TOTALS PER AGENT" EXPORT IS THE TABLE ON SCREEN (owner, 25 Nov 2026).
 *
 * The file used to carry its own column set: an "Answered" count the page
 * never shows (first replies SENT, including on chats later handed to someone
 * else, so it could exceed Chats - Sultan 58 of 53), medians, and raw seconds,
 * and it left out the customer rating. The owner compared the two and read the
 * file as wrong. It now has the page's columns, in the page's order, with the
 * page's values.
 */
export interface AgentSummaryLabels {
  agent: string;
  chats: string;
  noReplyYet: string;
  commonChats: string;
  firstResponse: string;
  solved: string;
  timeToSolve: string;
  rating: string;
}

export function agentSummaryExport(
  rows: readonly AgentPerformanceRow[],
  ratingByAgent: ReadonlyMap<string, { avg: number; n: number }>,
  labels: AgentSummaryLabels,
): { header: string[]; body: (string | number)[][] } {
  const header = [
    labels.agent,
    labels.chats,
    labels.noReplyYet,
    labels.commonChats,
    labels.firstResponse,
    labels.solved,
    labels.timeToSolve,
    labels.rating,
  ];
  const body = rows.map((r) => {
    const rating = ratingByAgent.get(r.agentId ?? '');
    return [
      r.agentName,
      r.chats,
      r.unanswered,
      r.commonChats,
      formatDuration(r.avgFirstResponseSec) ?? '',
      r.solved,
      formatDuration(r.avgTimeToSolveSec) ?? '',
      rating ? rating.avg.toFixed(1) : '',
    ];
  });
  return { header, body };
}
