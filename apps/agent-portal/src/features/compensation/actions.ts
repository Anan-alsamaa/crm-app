/**
 * The compensation action bar — an EXACT mirror of the production Directus
 * `compensation_requests.links-ycdmfv` (presentation-links) field: same buttons,
 * same order, same labels, same tones, same flow ids. Keep this list in lockstep
 * with that field so the portal and Directus admin present one identical bar.
 *
 * Each button fires that record's Directus manual flow
 * (POST /flows/trigger/{id} with { collection, keys, ...inputs }). Most actions
 * take no input (one click = one flow run). A few prod flows require the operator
 * to fill fields in the Directus manual-trigger dialog — those SAME fields are
 * collected in the portal (see `inputs`) and sent with the trigger, so nothing
 * has to be typed in Directus. Flow ids + input contracts are identical
 * local↔prod, so the portal just targets VITE_DIRECTUS_URL.
 */

/** Matches Directus presentation-links button `type`. */
export type CompLinkType = 'primary' | 'danger' | 'success';

/** How an input renders in the portal form. Mirrors the prod flow field. */
export type CompInputKind = 'text' | 'string' | 'dateTime' | 'select';

export interface CompInput {
  field: string;
  label: string;
  kind: CompInputKind;
  required: boolean;
  /** For `select` inputs (e.g. the coupon `side`). */
  choices?: { text: string; value: string }[];
}

export interface CompAction {
  key: string;
  label: string;
  flowId: string;
  type: CompLinkType;
  /** Manual inputs the prod flow requires; empty = one-click. */
  inputs: CompInput[];
}

// Order + labels + types + flow ids + inputs are copied verbatim from prod
// (presentation-links bar + each manual flow's trigger fields).
export const COMPENSATION_ACTIONS: CompAction[] = [
  {
    key: 'acknowledge',
    label: 'Acknowledge',
    flowId: 'f6fc9809-e036-40e8-921c-b1aae3fa4ef5',
    type: 'primary',
    inputs: [],
  },
  {
    key: 'accept',
    label: 'Accept',
    flowId: '6482d337-286e-4606-98de-21b734796b84',
    type: 'primary',
    inputs: [],
  },
  {
    key: 'reject',
    label: 'Reject',
    flowId: '9335c8fb-5744-43cc-9964-6fa0de0bb4d1',
    type: 'danger',
    inputs: [{ field: 'reason', label: 'Reason', kind: 'text', required: true }],
  },
  {
    key: 'calculate',
    label: 'Calculate Compensation',
    flowId: '90a0639c-1c2d-4eeb-814f-4a4885625ea0',
    type: 'primary',
    inputs: [],
  },
  {
    key: 'generate_coupon',
    label: 'Generate Coupon',
    flowId: 'fd7dd27e-fcbe-4447-9864-82817da5fc78',
    type: 'primary',
    inputs: [
      { field: 'coupon_name', label: 'Coupon Name', kind: 'string', required: true },
      { field: 'coupon_code', label: 'Coupon Code', kind: 'string', required: true },
      {
        field: 'side',
        label: 'Side',
        kind: 'select',
        required: true,
        choices: [{ text: 'ww', value: '1' }],
      },
      { field: 'date_from', label: 'Date From', kind: 'dateTime', required: true },
      { field: 'date_to', label: 'Date To', kind: 'dateTime', required: false },
      { field: 'time_form', label: 'Time From', kind: 'dateTime', required: false },
      { field: 'time_to', label: 'Time To', kind: 'dateTime', required: false },
    ],
  },
  {
    key: 'assign_coupon',
    label: 'User Assign Coupon',
    flowId: '9a09201e-ef25-4202-8afc-5088873b5905',
    type: 'primary',
    inputs: [],
  },
  {
    key: 'close',
    label: 'Close task',
    // Dedicated flow (the ex-"refund" flow) so Close sets its own "Closed"
    // status distinct from Accept's "Accepted".
    flowId: '13011877-701e-4d9c-b31e-711d196d097e',
    type: 'success',
    inputs: [{ field: 'reason', label: 'Reason', kind: 'text', required: false }],
  },
];
