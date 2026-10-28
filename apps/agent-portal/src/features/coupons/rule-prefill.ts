import {
  couponPrefix,
  differsFromPolicy,
  generateCouponCode,
  ruleCouponDraft,
  type CompensationRule,
  type CouponRequestDraft,
} from '@yiji/shared-types';

/**
 * THE COUPON SECTION, PRE-FILLED FROM THE COMPENSATION RULES (owner, 2026-10-27).
 *
 * When the agent picks the complaint type (and the other rule inputs), the
 * coupon section takes the matching rule's suggestion. The agent can accept
 * it, adjust it (then the request carries "differs from policy") or switch it
 * off. With no matching rule nothing is pre-filled.
 *
 * Kept as a pure reducer so the rules of who wins are testable without the
 * whole Add-ticket form:
 *   - the agent's own coupon (made without a rule) is never replaced;
 *   - an ADJUSTED suggestion is the agent's now, and is never replaced;
 *   - switching the coupon off is final for this form;
 *   - an untouched suggestion follows the inputs: a different rule replaces it,
 *     no rule clears it.
 */

/** The rule behind the collected coupon, and what it suggested. */
export interface AppliedRule {
  id: string;
  name: string;
  /** Exactly what the rule put in the coupon, to tell an adjustment from it. */
  suggested: CouponRequestDraft;
}

export interface RuleCouponState {
  assignCoupon: boolean;
  collectedCoupon: CouponRequestDraft | null;
  rule: AppliedRule | null;
  /** The agent switched a suggestion off: nothing is pre-filled again. */
  declined: boolean;
}

/** The suggestion for a rule, built fresh (new code) only when it is used. */
export function suggestionFor(
  rule: CompensationRule,
  ctx: {
    today: Date;
    phone: string | null;
    brandId: string | null;
    restaurantId: string | null;
    random?: () => number;
  },
): CouponRequestDraft {
  const draft = ruleCouponDraft(rule, {
    today: ctx.today,
    title: ctx.phone ?? '',
    code: 'PENDING',
    reason: '',
    brandId: ctx.brandId,
    restaurantId: ctx.restaurantId,
  });
  return {
    ...draft,
    code: generateCouponCode(ctx.random ?? Math.random, couponPrefix(draft.issuing_side)),
  };
}

/** Has the agent changed the suggested terms? */
export function isAdjusted(state: Pick<RuleCouponState, 'rule' | 'collectedCoupon'>): boolean {
  return (
    !!state.rule &&
    !!state.collectedCoupon &&
    differsFromPolicy(state.rule.suggested, state.collectedCoupon)
  );
}

/**
 * The state after the matching rule changed (or was first known).
 * `build` is only called when a NEW suggestion is actually applied.
 */
export function nextRuleCoupon(
  state: RuleCouponState,
  matched: CompensationRule | null,
  build: (rule: CompensationRule) => CouponRequestDraft,
): RuleCouponState {
  if (state.declined) return state;
  // The agent's own coupon, made without a rule: theirs.
  if (state.collectedCoupon && !state.rule) return state;
  // An adjusted suggestion is the agent's decision now.
  if (isAdjusted(state)) return state;
  // Same rule still matches: keep the suggestion (and its code) as it is.
  if (state.rule && matched && matched.id === state.rule.id) return state;
  if (matched) {
    const suggested = build(matched);
    return {
      assignCoupon: true,
      collectedCoupon: suggested,
      rule: { id: matched.id, name: matched.name, suggested },
      declined: false,
    };
  }
  if (state.rule) {
    // The untouched suggestion no longer applies.
    return { assignCoupon: false, collectedCoupon: null, rule: null, declined: false };
  }
  return state;
}

/**
 * What the coupon request records about the policy: the rule it came from,
 * and whether the agent changed its terms. Empty when no rule is involved -
 * so a request never names the new columns on an environment without them.
 */
export function policyFields(
  rule: AppliedRule | null,
  collected: CouponRequestDraft | null,
  /** Active rules exist (so the columns do too). With no matching rule, the
      request is marked - quietly - as made outside the rules (owner, 2026-10-27). */
  rulesActive = false,
): { policy_rule?: string; differs_from_policy?: boolean } {
  if (!collected) return {};
  if (!rule) return rulesActive ? { differs_from_policy: true } : {};
  return {
    policy_rule: rule.id,
    differs_from_policy: differsFromPolicy(rule.suggested, collected),
  };
}
