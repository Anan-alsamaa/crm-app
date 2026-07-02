/**
 * The compensation action bar — an EXACT mirror of the production Directus
 * `compensation_requests.links-ycdmfv` (presentation-links) field: same buttons,
 * same order, same labels, same tones, same flow ids. Keep this list in lockstep
 * with that field so the portal and Directus admin present one identical bar.
 * Each button triggers its Directus manual flow (POST /flows/trigger/{id}); the
 * flow ids are identical local↔prod, so the portal targets VITE_DIRECTUS_URL.
 */

export type CompActionInput = {
  field: string;
  label: string;
  /** input kind → how the form renders it */
  type: 'text' | 'string' | 'json' | 'dateTime';
  required: boolean;
};

/** Matches Directus presentation-links button `type`. */
export type CompLinkType = 'primary' | 'danger' | 'success';

export interface CompAction {
  key: string;
  label: string;
  flowId: string;
  type: CompLinkType;
  inputs: CompActionInput[];
  /** confirm-dialog copy for inputless actions */
  confirm?: string;
}

// Order + labels + types + flow ids are copied verbatim from the prod
// presentation-links config. Inputs come from each flow's trigger contract
// (directus/compensation-clone/flow-contract.json).
export const COMPENSATION_ACTIONS: CompAction[] = [
  {
    key: 'acknowledge',
    label: 'Acknowledge',
    flowId: 'f6fc9809-e036-40e8-921c-b1aae3fa4ef5',
    type: 'primary',
    inputs: [],
    confirm: 'Acknowledge this request and move it to In Progress?',
  },
  {
    key: 'accept',
    label: 'Accept',
    flowId: '6482d337-286e-4606-98de-21b734796b84',
    type: 'primary',
    inputs: [],
    confirm: 'Accept and approve this compensation request?',
  },
  {
    key: 'reject',
    label: 'Reject',
    flowId: '9335c8fb-5744-43cc-9964-6fa0de0bb4d1',
    type: 'danger',
    inputs: [{ field: 'reason', label: 'Reason', type: 'text', required: true }],
  },
  {
    key: 'calculate',
    label: 'Calculate Compensation',
    flowId: '90a0639c-1c2d-4eeb-814f-4a4885625ea0',
    type: 'primary',
    inputs: [],
    confirm: 'Calculate the suggested compensation for this request?',
  },
  {
    key: 'generate_coupon',
    label: 'Generate Coupon',
    flowId: 'fd7dd27e-fcbe-4447-9864-82817da5fc78',
    type: 'primary',
    inputs: [
      { field: 'coupon_name', label: 'Coupon name', type: 'string', required: true },
      { field: 'coupon_code', label: 'Coupon code', type: 'string', required: true },
      { field: 'side', label: 'Side (JSON)', type: 'json', required: true },
      { field: 'date_from', label: 'Valid from', type: 'dateTime', required: true },
      { field: 'date_to', label: 'Valid to', type: 'dateTime', required: false },
    ],
  },
  {
    key: 'assign_coupon',
    label: 'User Assign Coupon',
    flowId: '9a09201e-ef25-4202-8afc-5088873b5905',
    type: 'primary',
    inputs: [],
    confirm: 'Assign the generated coupon to this customer?',
  },
  {
    key: 'close',
    label: 'Close task',
    flowId: '6482d337-286e-4606-98de-21b734796b84',
    type: 'success',
    inputs: [],
    confirm: 'Close this task?',
  },
];
