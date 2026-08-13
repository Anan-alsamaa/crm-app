import {
  buildComplaintsTemplate,
  downloadWorkbook,
  type ComplaintsTemplateInput,
} from '@yiji/reports';
import type { TicketRow } from './api.js';

/**
 * One ticket, exported as a filled row in the official upload-template format.
 *
 * The point of using the TEMPLATE layout rather than an ad-hoc sheet: the file
 * that leaves this button is the same shape the import accepts and the same
 * shape the ops team reads all day — headers, dropdowns, column order. A
 * one-off export format would be a third dialect for the same data.
 *
 * Administrator-only by request; the caller gates visibility.
 */
export function exportTicketWorkbook(
  tk: TicketRow,
  agentName: string,
  lists: ComplaintsTemplateInput['lists'],
): void {
  const snap = tk.order_snapshot ?? null;
  const store = tk.store_snapshot ?? null;
  const when = tk.complaint_date ?? tk.date_created ?? null;
  const d = when ? new Date(when) : null;
  const pad = (n: number) => String(n).padStart(2, '0');

  const fill: Record<string, string | number> = {
    Date: d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '',
    Time: d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '',
    Chain: store?.chainManager ?? '',
    Area: store?.areaManager ?? '',
    Brand: store?.brandName ?? snap?.brandName ?? '',
    City: store?.city ?? '',
    'Restaurant name': store?.restaurantName ?? snap?.restaurantName ?? '',
    'Service type': tk.service_type ?? '',
    'Complaint type': tk.complaint_type ?? '',
    'Customer mobile': tk.contact?.phone ?? '',
    'Complaint description': tk.description ?? '',
    Response: tk.response_desc ?? '',
    'Complaint source': tk.complaint_source ?? '',
    'Order amount': snap?.total != null ? Number(snap.total) : '',
    'Order number': tk.order_id ?? (snap?.orderId != null ? String(snap.orderId) : ''),
    'Communication method': tk.communication_method ?? '',
    'Coupon code': tk.coupon_code ?? '',
    'Coupon value': tk.coupon_value != null ? Number(tk.coupon_value) : '',
    'Coupon %': tk.coupon_percent != null ? Number(tk.coupon_percent) : '',
    'Complaint status': tk.status,
    Agent: agentName,
    Compensation: tk.compensation ?? '',
  };

  const sheets = buildComplaintsTemplate({
    lists,
    restaurants: [],
    brands: [],
    cities: [],
    agents: [],
    statuses: ['new', 'open', 'pending', 'resolved', 'closed'],
  });
  const headers = sheets[0]!.columns.map((c) => c.header);
  sheets[0]!.rows = [headers.map((h) => fill[h] ?? '')];
  // A single-ticket export needs no dropdown scaffolding — the data is final.
  sheets[0]!.validations = [];

  downloadWorkbook(`complaint-${tk.order_id ?? tk.id.slice(0, 8)}.xlsx`, sheets);
}
