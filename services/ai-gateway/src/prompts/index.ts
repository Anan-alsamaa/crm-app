import type { ConversationContext } from '../directus/index.js';

/**
 * Prompt builders.
 *
 * One per endpoint. Each takes the (already-fetched) Directus context plus
 * any endpoint-specific args and returns a `{ system, user }` pair the
 * provider can run directly. PII redaction is applied to the returned pair
 * by the caller — never bake raw context into a system prompt here.
 */

function thread(ctx: ConversationContext): string {
  if (!ctx.messages.length) return '(no messages yet)';
  return ctx.messages
    .filter((m) => !m.is_internal_note)
    .map((m) => `${m.sender_type === 'agent' ? 'Agent' : 'Customer'}: ${m.content}`)
    .join('\n');
}

export const prompts = {
  summarize(ctx: ConversationContext): { system: string; user: string } {
    return {
      system:
        'You write tight customer-support conversation summaries. ' +
        'Three short sentences max: what the customer asked, what was done, what is outstanding. ' +
        'No greetings, no preamble. Plain text.',
      user: `Summarize this conversation:\n\n${thread(ctx)}`,
    };
  },

  suggestReply(
    ctx: ConversationContext,
    draft: string | undefined,
    locale: string | undefined,
  ): { system: string; user: string } {
    return {
      system:
        'You draft helpful, concise customer-support replies on behalf of an agent. ' +
        "Match the customer's language. Be specific, never invent facts. " +
        'No greetings or sign-offs unless the existing thread sets that tone. ' +
        `${locale ? `Reply in: ${locale}.` : ''}`,
      user:
        `Conversation so far:\n${thread(ctx)}\n\n` +
        `${draft ? `Agent's draft to refine:\n${draft}` : 'Propose a reply.'}`,
    };
  },

  analyzeSentiment(ctx: ConversationContext): { system: string; user: string } {
    return {
      system:
        'You classify customer sentiment from a support conversation. ' +
        'Respond with EXACTLY one JSON object: {"label":"positive|neutral|negative","score":0..1}. ' +
        'No prose, no markdown.',
      user: thread(ctx),
    };
  },

  detectIntent(ctx: ConversationContext): { system: string; user: string } {
    return {
      system:
        "You detect the customer's primary intent in a support conversation. " +
        'Respond with EXACTLY one JSON object: {"intent":"<short lowercase tag>","confidence":0..1}. ' +
        'Use generic intents (refund, shipping_issue, account_access, product_question, billing, complaint, other). ' +
        'No prose.',
      user: thread(ctx),
    };
  },

  extractEntities(ctx: ConversationContext): { system: string; user: string } {
    return {
      system:
        'You extract structured entities from a conversation. ' +
        'Respond with EXACTLY one JSON object: {"entities":[{"type":"<order|product|date|amount|tracking|other>","value":"<raw text>"}, ...]}. ' +
        'No prose, no markdown.',
      user: thread(ctx),
    };
  },

  semanticSearch(
    query: string,
    snippets: Array<{ id: string; text: string }>,
  ): { system: string; user: string } {
    return {
      system:
        'You rank conversation snippets by semantic relevance to a query. ' +
        'Respond with EXACTLY one JSON object: ' +
        '{"results":[{"conversationId":"<id>","score":0..1,"snippet":"<<=200 chars>"}, ...]}. ' +
        'Higher score = more relevant. No prose.',
      user: `Query: ${query}\n\nSnippets:\n${snippets
        .map((s) => `[${s.id}] ${s.text}`)
        .join('\n')}`,
    };
  },

  scoreLead(ctx: ConversationContext): { system: string; user: string } {
    return {
      system:
        'You score the lead quality of a customer conversation. ' +
        'Respond with EXACTLY one JSON object: ' +
        '{"score":0..100,"signals":["<short reason>", ...]}. ' +
        'Signals are 1-5 short positive or negative indicators. No prose.',
      user: thread(ctx),
    };
  },

  orderAssist(
    orderData: unknown,
    question: string | undefined,
    locale: string | undefined,
  ): { system: string; user: string } {
    return {
      system:
        'You are a customer-support assistant helping an agent with a customer order. ' +
        'Use ONLY the order JSON provided — never invent or guess any value; if a field is ' +
        'absent, omit it rather than guessing. Give a COMPLETE, well-structured answer in plain ' +
        'text (no markdown tables), using short labelled lines:\n' +
        '• For a SINGLE order: Order #, date placed, status, restaurant, each item (name ×qty — ' +
        'price), Total (with currency), delivery address, and payment when present.\n' +
        '• For a LIST of orders: one line per order — Order #, date, status, total (with currency).\n' +
        'When the agent asks a specific question, answer it first, then include the supporting ' +
        'order details. ' +
        `${locale ? `Answer in: ${locale}.` : "Match the customer's language."}`,
      user:
        `Order data (JSON):\n${JSON.stringify(orderData)}\n\n` +
        `${
          question
            ? `Agent question: ${question}\nAnswer it, then list the full order details above.`
            : 'Give the full details of the order(s) above.'
        }`,
    };
  },
};
