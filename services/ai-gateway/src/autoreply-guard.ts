/**
 * AI AUTO-REPLY HARD LIMITS (owner, 2026-10-13; docs/AI-AUTO-REPLY-PLAN.md).
 *
 * Deterministic, so they hold whatever the model does:
 *  - BEFORE the model: a customer who asks for a person, for money back or a
 *    coupon, or whether this is a bot, goes straight to an agent - no call.
 *  - AFTER the model: a reply that offers compensation, a refund, a coupon or
 *    a discount, or that claims to be human, is never used; it becomes a
 *    handover. Coupons and compensation stay with agents, as today.
 *
 * Arabic and English, because customers write both.
 */

export type HandoverReason = 'asked_for_person' | 'asked_for_compensation' | 'asked_if_bot';

const ASKS_FOR_PERSON = [
  /\b(human|person|agent|representative|real person|someone|supervisor|manager)\b/i,
  /(موظف|انسان|إنسان|شخص|مشرف|مدير|خدمة العملاء|كلمني|اكلم|أكلم)/,
];
const ASKS_FOR_COMPENSATION = [
  /\b(refund|money back|compensat\w*|coupon|voucher|discount|credit|reimburs\w*)\b/i,
  /(تعويض|استرجاع|استرداد|ارجاع المبلغ|إرجاع المبلغ|كوبون|قسيمة|خصم|فلوسي|رصيد)/,
];
const ASKS_IF_BOT = [
  /\b(bot|robot|chatbot|ai|automated|machine)\b/i,
  // Not `الي`: in dialect it is "which/that", in half of all messages.
  /(روبوت|بوت|آلي|ذكاء اصطناعي|رد آلي)/,
];

const any = (res: RegExp[], text: string) => res.some((re) => re.test(text));

/** The customer's message says a person must take this; null when it does not. */
export function preCheck(customerText: string): HandoverReason | null {
  const t = customerText.trim();
  if (!t) return null;
  if (any(ASKS_IF_BOT, t)) return 'asked_if_bot';
  if (any(ASKS_FOR_COMPENSATION, t)) return 'asked_for_compensation';
  if (any(ASKS_FOR_PERSON, t)) return 'asked_for_person';
  return null;
}

const OFFERS_MONEY = [
  /\b(refund\w*|compensat\w*|coupon\w*|voucher\w*|discount\w*|credit\w*|reimburs\w*|promo code)\b/i,
  /(تعويض|استرجاع|استرداد|كوبون|قسيمة|خصم|رصيد|كود)/,
];
const CLAIMS_HUMAN = [
  /\b(i am|i'm) (a )?(human|real person|not a (bot|robot|machine))\b/i,
  /(أنا|انا) (إنسان|انسان|موظف حقيقي|لست روبوت|مو روبوت|مب روبوت)/,
];

/** Why a model reply must not be used; null when it is acceptable. */
export function postCheck(reply: string): 'mentions_compensation' | 'claims_human' | null {
  if (any(OFFERS_MONEY, reply)) return 'mentions_compensation';
  if (any(CLAIMS_HUMAN, reply)) return 'claims_human';
  return null;
}
