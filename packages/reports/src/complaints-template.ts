import {
  COMPLAINT_COLUMN_KEYS,
  COMPLAINT_COLUMN_LABELS,
  type ComplaintColumnKey,
} from './complaints.js';
import type { Sheet, SheetValidation } from './xlsx.js';

/**
 * The bulk-upload template, with the live dropdowns baked in.
 *
 * Ships as two sheets: 'Complaints' (fill from row 2 down) and a HIDDEN
 * 'Lists' sheet the dropdowns reference. The column headers are the same
 * display names the importer's alias table maps back, so a filled template
 * round-trips through Import without any renaming — that closed loop is the
 * whole reason to generate the file from inside the app rather than shipping
 * a static one: the dropdowns always match what the system will accept TODAY.
 *
 * Columns the report derives (year/month/week/day) are left out — the importer
 * ignores them and every derived column invites contradicting the date it was
 * derived from.
 */
const TEMPLATE_KEYS: ComplaintColumnKey[] = COMPLAINT_COLUMN_KEYS.filter(
  // year/month/week/day are derived from the date; the last-modified pair is
  // an audit stamp the system writes — none of them belong on an upload sheet.
  (k) => !['year', 'month', 'week', 'day', 'lastModifiedBy', 'lastModifiedAt'].includes(k),
);

/** How many data rows the dropdowns cover. Generous, not infinite. */
const TEMPLATE_ROWS = 1000;

export interface ComplaintsTemplateInput {
  /** The live option lists, keyed the way `option_lists.list` keys them. */
  lists: Partial<Record<string, string[]>>;
  restaurants: string[];
  brands: string[];
  cities: string[];
  agents: string[];
  /** Ticket statuses as the system accepts them. */
  statuses: string[];
}

/** Which template column draws from which value set. */
const DROPDOWN_SOURCES: Partial<
  Record<ComplaintColumnKey, keyof ComplaintsTemplateInput | `lists.${string}`>
> = {
  complaintType: 'lists.complaint_type',
  serviceType: 'lists.service_type',
  complaintSource: 'lists.complaint_source',
  communicationMethod: 'lists.communication_method',
  compensation: 'lists.compensation',
  restaurantName: 'restaurants',
  brand: 'brands',
  city: 'cities',
  agent: 'agents',
  complaintStatus: 'statuses',
};

export function buildComplaintsTemplate(input: ComplaintsTemplateInput): Sheet[] {
  const resolve = (source: string): string[] => {
    if (source.startsWith('lists.')) return input.lists[source.slice(6)] ?? [];
    return (input[source as keyof ComplaintsTemplateInput] as string[]) ?? [];
  };

  // Lists sheet: one column per value set, in template-column order.
  const listColumns: { header: string; values: string[] }[] = [];
  const listColOf = new Map<ComplaintColumnKey, number>();
  for (const key of TEMPLATE_KEYS) {
    const source = DROPDOWN_SOURCES[key];
    if (!source) continue;
    const values = resolve(source);
    if (values.length === 0) continue; // an empty dropdown is a locked column
    listColOf.set(key, listColumns.length);
    listColumns.push({ header: COMPLAINT_COLUMN_LABELS[key].def, values });
  }
  const tallest = Math.max(0, ...listColumns.map((c) => c.values.length));
  const listRows: (string | null)[][] = Array.from({ length: tallest }, (_, r) =>
    listColumns.map((c) => c.values[r] ?? null),
  );

  const colLetterOf = (index: number): string => {
    let n = index + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };

  const validations: SheetValidation[] = [];
  TEMPLATE_KEYS.forEach((key, col) => {
    const listCol = listColOf.get(key);
    if (listCol === undefined) return;
    const letter = colLetterOf(listCol);
    const count = listColumns[listCol]!.values.length;
    validations.push({
      col,
      fromRow: 2,
      toRow: TEMPLATE_ROWS + 1,
      formula: `Lists!$${letter}$2:$${letter}$${count + 1}`,
    });
  });

  return [
    {
      name: 'Complaints',
      columns: TEMPLATE_KEYS.map((k) => ({
        header: COMPLAINT_COLUMN_LABELS[k].def,
        width: ['complaintDescription', 'responseDesc'].includes(k) ? 40 : 18,
      })),
      rows: [],
      validations,
    },
    {
      name: 'Lists',
      hidden: true,
      columns: listColumns.map((c) => ({ header: c.header })),
      rows: listRows,
    },
  ];
}
