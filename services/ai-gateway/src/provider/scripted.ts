import type { AIProvider, AiRunInput, AiRunOutput } from './types.js';
import { AiProviderError } from './types.js';

/**
 * THE SCRIPTED TEST AI (owner, 2026-11-09: test Maha rigorously on staging,
 * with no AI cost until approval).
 *
 * Answers ONLY the chat-reply endpoint, from markers the tester types into the
 * customer's message, so every case can be driven through the real widget,
 * routing, inbox and reports - repeatably, free, and without sending anything
 * to Google. Every other endpoint (summaries, sentiment...) goes to the real
 * provider unchanged.
 *
 *   [[handover]]      the model decides a person must take it
 *   [[offerx]]        the model wrongly offers a coupon (the hard-limit check
 *                     must turn it into a handover)
 *   [[claimx]]        the model wrongly claims to be human (same)
 *   (Markers avoid the words "compensation" / "human": the customer-side
 *   check would hand those over before the model is ever asked.)
 *   [[empty]]         the model answers with an empty reply
 *   [[garbage]]       the model answers with text that is not JSON
 *   [[fail]]          the provider is down (503)
 *   [[slow]]          the provider hangs past the watchdog
 *   anything else     a normal reply, in the customer's language
 *
 * Refused outside staging by `index.ts`: it must never answer a real customer.
 */
export class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';

  constructor(
    private readonly fallback: AIProvider,
    private readonly opts: { slowMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async run(input: AiRunInput): Promise<AiRunOutput> {
    if (input.endpoint !== '/auto-reply') return this.fallback.run(input);
    const last = lastCustomerLine(input.user);
    const out = (text: string): AiRunOutput => ({
      text,
      model: 'scripted',
      usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
    });
    const json = (o: unknown) => out(JSON.stringify(o));
    const arabic = /\p{Script=Arabic}/u.test(last);

    if (last.includes('[[fail]]')) {
      throw new AiProviderError('[503 Service Unavailable] scripted', 'provider_unavailable', 503);
    }
    if (last.includes('[[slow]]')) {
      const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      await sleep(this.opts.slowMs ?? 60_000);
    }
    if (last.includes('[[garbage]]')) return out('Sure! Here is my answer, not in JSON.');
    if (last.includes('[[empty]]')) return json({ action: 'reply', reply: '', reason: null });
    if (last.includes('[[handover]]')) {
      return json({ action: 'handover', reply: null, reason: 'scripted: needs a person' });
    }
    if (last.includes('[[offerx]]')) {
      return json({
        action: 'reply',
        reply: arabic ? 'سنضيف لك كوبون تعويض.' : 'We will add a compensation coupon for you.',
        reason: null,
      });
    }
    if (last.includes('[[claimx]]')) {
      return json({ action: 'reply', reply: "I'm a real person, not a bot.", reason: null });
    }
    const echo = last
      .replace(/\[\[[a-z]+\]\]/g, '')
      .trim()
      .slice(0, 80);
    return json({
      action: 'reply',
      reply: arabic ? `رد تجريبي من مها على: ${echo}` : `Scripted reply from Maha to: ${echo}`,
      reason: null,
    });
  }
}

/** The customer's last line in the auto-reply prompt's transcript. */
function lastCustomerLine(user: string): string {
  const lines = user.split('\n').filter((l) => l.startsWith('Customer: '));
  return (lines[lines.length - 1] ?? '').slice('Customer: '.length);
}
