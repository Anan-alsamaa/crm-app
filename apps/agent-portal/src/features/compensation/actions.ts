/**
 * The compensation action bar — an EXACT mirror of the production Directus
 * `compensation_requests.links-ycdmfv` (presentation-links) field: same buttons,
 * same order, same labels, same tones, same flow ids. Keep this list in lockstep
 * with that field so the portal and Directus admin present one identical bar.
 *
 * The portal is a THIN trigger surface: clicking a button fires that record's
 * Directus manual flow (POST /flows/trigger/{id} with { collection, keys }) and
 * nothing else. All logic — calculations, coupon generation, the Yiji API calls,
 * status transitions — lives in the Directus flows. No inputs, no confirm step:
 * one click = one flow run on the selected record. Flow ids are identical
 * local↔prod, so the portal just targets VITE_DIRECTUS_URL.
 */

/** Matches Directus presentation-links button `type`. */
export type CompLinkType = 'primary' | 'danger' | 'success';

export interface CompAction {
  key: string;
  label: string;
  flowId: string;
  type: CompLinkType;
}

// Order + labels + types + flow ids are copied verbatim from the prod
// presentation-links config.
export const COMPENSATION_ACTIONS: CompAction[] = [
  {
    key: 'acknowledge',
    label: 'Acknowledge',
    flowId: 'f6fc9809-e036-40e8-921c-b1aae3fa4ef5',
    type: 'primary',
  },
  {
    key: 'accept',
    label: 'Accept',
    flowId: '6482d337-286e-4606-98de-21b734796b84',
    type: 'primary',
  },
  {
    key: 'reject',
    label: 'Reject',
    flowId: '9335c8fb-5744-43cc-9964-6fa0de0bb4d1',
    type: 'danger',
  },
  {
    key: 'calculate',
    label: 'Calculate Compensation',
    flowId: '90a0639c-1c2d-4eeb-814f-4a4885625ea0',
    type: 'primary',
  },
  {
    key: 'generate_coupon',
    label: 'Generate Coupon',
    flowId: 'fd7dd27e-fcbe-4447-9864-82817da5fc78',
    type: 'primary',
  },
  {
    key: 'assign_coupon',
    label: 'User Assign Coupon',
    flowId: '9a09201e-ef25-4202-8afc-5088873b5905',
    type: 'primary',
  },
  {
    key: 'close',
    label: 'Close task',
    // Dedicated flow (the ex-"refund" flow) so Close sets its own "Closed"
    // status distinct from Accept's "Accepted".
    flowId: '13011877-701e-4d9c-b31e-711d196d097e',
    type: 'success',
  },
];
