import type { CompensationStatus } from './api.js';

/**
 * The agent workflow, mirrored from directus/compensation-clone/flow-contract.json.
 * Each entry is a Directus manual flow (triggered by id) + the inputs the UI must
 * collect + the statuses in which the button is offered. Keep in sync with the
 * contract file (the flow ids are identical in local + prod).
 */

export type CompActionInput = {
  field: string;
  label: string;
  /** input kind → how the form renders it */
  type: 'text' | 'string' | 'json' | 'dateTime';
  required: boolean;
};

export type CompActionTone = 'primary' | 'success' | 'destructive' | 'neutral';

export interface CompAction {
  key: string;
  label: string;
  flowId: string;
  inputs: CompActionInput[];
  availableWhen: CompensationStatus[];
  tone: CompActionTone;
  /** confirm dialog copy for inputless actions */
  confirm?: string;
}

export const COMPENSATION_ACTIONS: CompAction[] = [
  {
    key: 'acknowledge',
    label: 'Acknowledge',
    flowId: 'f6fc9809-e036-40e8-921c-b1aae3fa4ef5',
    inputs: [],
    availableWhen: ['Pending'],
    tone: 'primary',
    confirm: 'Acknowledge this request and move it to In Progress?',
  },
  {
    key: 'calculate',
    label: 'Calculate compensation',
    flowId: '90a0639c-1c2d-4eeb-814f-4a4885625ea0',
    inputs: [],
    availableWhen: ['In Progress'],
    tone: 'neutral',
    confirm: 'Calculate the suggested compensation for this request?',
  },
  {
    key: 'generate_coupon',
    label: 'Generate coupon',
    flowId: 'fd7dd27e-fcbe-4447-9864-82817da5fc78',
    inputs: [
      { field: 'coupon_name', label: 'Coupon name', type: 'string', required: true },
      { field: 'coupon_code', label: 'Coupon code', type: 'string', required: true },
      { field: 'side', label: 'Side (JSON)', type: 'json', required: true },
      { field: 'date_from', label: 'Valid from', type: 'dateTime', required: true },
      { field: 'date_to', label: 'Valid to', type: 'dateTime', required: false },
    ],
    availableWhen: ['In Progress'],
    tone: 'primary',
  },
  {
    key: 'assign_coupon',
    label: 'Assign coupon',
    flowId: '9a09201e-ef25-4202-8afc-5088873b5905',
    inputs: [],
    availableWhen: ['In Progress'],
    tone: 'primary',
    confirm: 'Assign the generated coupon to this customer?',
  },
  {
    key: 'approve',
    label: 'Accept',
    flowId: '6482d337-286e-4606-98de-21b734796b84',
    inputs: [],
    availableWhen: ['In Progress'],
    tone: 'success',
    confirm: 'Accept and approve this compensation request?',
  },
  {
    key: 'reject',
    label: 'Reject',
    flowId: '9335c8fb-5744-43cc-9964-6fa0de0bb4d1',
    inputs: [{ field: 'reason', label: 'Reason', type: 'text', required: true }],
    availableWhen: ['Pending', 'In Progress'],
    tone: 'destructive',
  },
  {
    key: 'refund',
    label: 'Refund amount',
    flowId: '13011877-701e-4d9c-b31e-711d196d097e',
    inputs: [{ field: 'reason', label: 'Reason', type: 'text', required: false }],
    availableWhen: ['In Progress', 'Approved'],
    tone: 'neutral',
  },
];

export function actionsForStatus(status: CompensationStatus): CompAction[] {
  return COMPENSATION_ACTIONS.filter((a) => a.availableWhen.includes(status));
}
