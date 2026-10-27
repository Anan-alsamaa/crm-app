import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createItem, readItems, updateItem } from '@directus/sdk';
import {
  couponIsSuperseded,
  couponPrefix,
  generateCouponCode,
  refId,
  startCouponReplacement,
  waitForCouponReplacement,
  type CouponReplacementTerms,
  type CouponReplaceState,
  type ReplaceableCoupon,
} from '@yiji/shared-types';
import { directus } from '../../lib/directus.js';
import { jobProducer } from '../../lib/job-producer.js';

/**
 * EDITED-AFTER-APPROVAL COUPONS, as the admin portal reads them (owner,
 * 2026-10-27).
 *
 * ONE small read of only the rows that take part in an edit, and it is the
 * only read that names `replaces` / `replaced_by`: those need a manual
 * `apply:fields`, and naming a missing field 403s the WHOLE query - so every
 * report keeps its own read untouched and asks this one, best-effort, which
 * rows to leave out. Failing it, nothing has been replaced: the reports show
 * exactly what they showed before the feature existed.
 */
export interface CouponReplacementLink {
  id: string;
  status: string | null;
  replaces: { id: string; code: string | null } | null;
  replacedBy: { id: string; code: string | null } | null;
  reason: string | null;
  /** Leave this row OUT of totals (`couponIsSuperseded`). */
  superseded: boolean;
}

type LinkRow = {
  id: string | number;
  status: string | null;
  replace_reason?: string | null;
  replaces?: { id?: string | number | null; coupon_code?: string | null } | null;
  replaced_by?: { id?: string | number | null; coupon_code?: string | null } | null;
};

const link = (v: LinkRow['replaces']) => {
  const id = refId(v ?? null);
  return id ? { id, code: v?.coupon_code ?? null } : null;
};

export async function readCouponReplacements(): Promise<Map<string, CouponReplacementLink>> {
  try {
    const rows = (await directus.request(
      readItems(
        'coupon_approvals' as never,
        {
          filter: { _or: [{ replaced_by: { _nnull: true } }, { replaces: { _nnull: true } }] },
          fields: [
            'id',
            'status',
            'replace_reason',
            { replaces: ['id', 'coupon_code'] },
            { replaced_by: ['id', 'coupon_code'] },
          ],
          limit: -1,
        } as never,
      ),
    )) as unknown as LinkRow[];
    const out = new Map<string, CouponReplacementLink>();
    for (const r of rows ?? []) {
      const replaces = link(r.replaces);
      const replacedBy = link(r.replaced_by);
      out.set(String(r.id), {
        id: String(r.id),
        status: r.status,
        replaces,
        replacedBy,
        reason: r.replace_reason ?? null,
        superseded: couponIsSuperseded({
          status: r.status,
          replaces: replaces?.id ?? null,
          replaced_by: replacedBy?.id ?? null,
        }),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

/** The ids every coupon total must leave out. */
export async function readSupersededCouponIds(): Promise<Set<string>> {
  const links = await readCouponReplacements();
  return new Set([...links.values()].filter((l) => l.superseded).map((l) => l.id));
}

export function useCouponReplacements() {
  return useQuery({
    queryKey: ['coupon-replacements'],
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: readCouponReplacements,
  });
}

/** What the editor's form hands over. */
export interface ReplaceCouponInput {
  old: ReplaceableCoupon;
  terms: CouponReplacementTerms;
  reason: string;
  editorId: string | null;
}

/**
 * Edit an APPROVED coupon (owner, 2026-10-27): create the replacement with
 * this user's token, hand the pair to the workers, then WAIT (bounded) on the
 * two rows for the outcome. No Yiji call from here - "was it used?" is asked by
 * the workers, for this one coupon, after the click.
 */
export function useReplaceCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: ReplaceCouponInput,
    ): Promise<{ code: string; state: CouponReplaceState; note: string | null }> => {
      const { replacementId, code } = await startCouponReplacement(
        {
          codeTaken: async (c) => {
            const hit = (await directus.request(
              readItems(
                'coupon_approvals' as never,
                { filter: { coupon_code: { _eq: c } }, fields: ['id'], limit: 1 } as never,
              ),
            )) as unknown as unknown[];
            return Array.isArray(hit) && hit.length > 0;
          },
          create: (row) => directus.request(createItem('coupon_approvals' as never, row as never)),
          enqueue: (body) => jobProducer.replaceCoupon(body),
          abandon: (id, note) =>
            directus.request(
              updateItem('coupon_approvals' as never, id, {
                status: 'rejected',
                decision_note: note,
              } as never),
            ),
          newId: () => crypto.randomUUID(),
          newCode: (side) => generateCouponCode(Math.random, couponPrefix(side)),
        },
        input,
      );
      void qc.invalidateQueries({ queryKey: ['coupon-approvals'] });
      const settled = await waitForCouponReplacement(async () => {
        const rows = (await directus.request(
          readItems(
            'coupon_approvals' as never,
            {
              filter: { id: { _in: [input.old.id, replacementId] } },
              fields: ['id', 'status', 'decision_note', 'removal_status', 'replaced_by'],
              limit: 2,
            } as never,
          ),
        )) as unknown as Array<{
          id: string;
          status: string | null;
          decision_note: string | null;
          removal_status: string | null;
          replaced_by: string | null;
        }>;
        return {
          replacement: rows.find((r) => String(r.id) === replacementId) ?? null,
          old: rows.find((r) => String(r.id) === input.old.id) ?? null,
        };
      });
      return { code, ...settled };
    },
    onSettled: () => {
      for (const key of [
        'coupon-approvals',
        'coupon-replacements',
        'all-compensation',
        'coupon-approval-facts',
        'coupon-spend',
        'admin-kpi',
        'agent-reports',
        'complaint-metrics',
        'dashboard-metrics',
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
