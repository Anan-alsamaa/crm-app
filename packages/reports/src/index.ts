/**
 * Report formats shared across the portals.
 *
 * Today that is the operations team's complaints report, which the admin
 * portal shows in full and the agent portal shows scoped to the signed-in
 * agent. Anything both portals must agree on belongs here; anything only one
 * of them needs stays in that app.
 */
export {
  buildComplaintsSheets,
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
  COMPLAINT_COLUMN_LAYOUT,
  complaintCell,
  countUnmappedComplaints,
  filterComplaintRows,
  isoWeek,
  moveColumn,
  reconcileColumnOrder,
  loadColumnOrder,
  saveColumnOrder,
  TICKET_REPORT_ORDER_KEY,
  joinComplaintStores,
  reportFilename,
  splitLocalDateTime,
  type ComplaintColumnKey,
  type ComplaintColumnLayout,
  type ComplaintReportRow,
  type Translate,
} from './complaints.js';
export {
  buildWorkbook,
  downloadWorkbook,
  type CellValue,
  type Sheet,
  type SheetColumn,
} from './xlsx.js';

export {
  parseTicketsCsv,
  toComplaintDate,
  toNumberCell,
  isBlankCell,
  ticketPayloadFromCsvRow,
  type TicketPayloadContext,
  type TicketCsvRow,
  type ParseTicketsResult,
} from './import-csv.js';

export {
  agentPerformance,
  firstResponseSec,
  timeToSolveSec,
  metFirstResponse,
  splitBySla,
  formatDuration,
  type ChatTiming,
  type AgentPerformanceRow,
} from './agent-performance.js';

export {
  comparisonRows,
  dailyTrend,
  performanceSummary,
  type ComparisonRow,
  type DailyPoint,
  type PerformanceSummary,
} from './agent-performance-view.js';

export {
  distinctValues,
  filterTickets,
  isEmptyFilter,
  matchesTicketFilter,
  type FilterableTicketRow,
  type TicketFilterCriteria,
} from './ticket-filter.js';

export {
  conversationTimestamps,
  type ConversationTimestamps,
  type TimingMessage,
} from './chat-timings.js';

export { chatHandoffs, missedOffers, type ChatHandoff, type RoutingEvent } from './handoffs.js';
