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
  countUnmappedComplaints,
  joinComplaintStores,
  reportFilename,
  splitLocalDateTime,
  type ComplaintColumnKey,
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
