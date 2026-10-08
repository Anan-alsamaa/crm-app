import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CrmClient } from './client.js';
import { withHeader } from './format.js';
import { getOrder, lateOrders } from './tools/commerce.js';
import { getConversation, searchConversations } from './tools/conversations.js';
import { searchCoupons } from './tools/coupons.js';
import { genericQuery } from './tools/generic.js';
import { releaseStatus } from './tools/release.js';
import { agentActivity, aiUsage } from './tools/reports.js';
import { getTicket, searchTickets } from './tools/tickets.js';

export interface ServerDeps {
  /** Built lazily so listing tools works before any credential is read. */
  client: () => CrmClient;
  /** Repo root, for `crm_release_status`. */
  repoRoot: string;
}

const RO = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const day = z.string().describe('YYYY-MM-DD (a Riyadh day, inclusive) or a full ISO timestamp');
const limit = (max: number, def: number) =>
  z.number().int().min(1).max(max).optional().describe(`max rows (default ${def}, cap ${max})`);

/** Every result starts with the PRODUCTION header line; errors too. */
async function answer(fn: () => Promise<string>) {
  try {
    return { content: [{ type: 'text' as const, text: withHeader(await fn()) }] };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: withHeader(`ERROR ${msg}`) }],
    };
  }
}

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'crm-prod', version: '0.1.0' },
    {
      instructions:
        'READ-ONLY access to the PRODUCTION Sara/Yiji CRM (crm-api.anan.sa). There is no staging mode. ' +
        'Nothing here can write. Phones are stored as 05XXXXXXXX; times are shown in Riyadh (UTC+3) with UTC in brackets.',
    },
  );
  const c = deps.client;

  server.registerTool(
    'crm_search_conversations',
    {
      title: 'Search chats (production)',
      description:
        'Find chats by customer phone (any format) or name fragment, status (open|solved) and a date range on the last message. Returns id, customer, status, agent, last message time, vendor.',
      inputSchema: {
        phone: z.string().optional(),
        name: z.string().optional(),
        status: z.enum(['open', 'solved']).optional(),
        from: day.optional(),
        to: day.optional(),
        limit: limit(100, 20),
      },
      annotations: RO,
    },
    (a) => answer(() => searchConversations(c(), a)),
  );

  server.registerTool(
    'crm_get_conversation',
    {
      title: 'One chat with messages (production)',
      description:
        'One chat: customer, agent, SLA (first response due/responded/breached), linked tickets, and its messages (sender, source, content; deleted/edited marked; internal notes flagged).',
      inputSchema: { id: z.string().uuid(), messageLimit: limit(500, 200) },
      annotations: RO,
    },
    (a) => answer(() => getConversation(c(), a.id, a.messageLimit)),
  );

  server.registerTool(
    'crm_search_tickets',
    {
      title: 'Search tickets (production)',
      description:
        'Find tickets by id, order id, customer phone, subject/description text, status (pending|solved; legacy open/new/resolved/closed also stored) and a created-date range.',
      inputSchema: {
        id: z.string().optional(),
        orderId: z.string().optional(),
        phone: z.string().optional(),
        text: z.string().optional(),
        status: z.string().optional(),
        from: day.optional(),
        to: day.optional(),
        limit: limit(100, 20),
      },
      annotations: RO,
    },
    (a) => answer(() => searchTickets(c(), a)),
  );

  server.registerTool(
    'crm_get_ticket',
    {
      title: 'One ticket with timeline (production)',
      description:
        'Ticket detail: complaint fields, SLA, compensation, the ticket_events timeline and its coupon requests.',
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    (a) => answer(() => getTicket(c(), a.id)),
  );

  server.registerTool(
    'crm_coupons',
    {
      title: 'Coupon approvals (production)',
      description:
        'coupon_approvals by id, code, phone, order id, status (pending|edited|approved|rejected|assigned) or requested-date range: terms, status, Yiji couponUserId/couponId, push error, who requested/decided.',
      inputSchema: {
        id: z.string().optional(),
        code: z.string().optional(),
        phone: z.string().optional(),
        orderId: z.string().optional(),
        status: z.string().optional(),
        from: day.optional(),
        to: day.optional(),
        limit: limit(100, 20),
      },
      annotations: RO,
    },
    (a) => answer(() => searchCoupons(c(), a)),
  );

  server.registerTool(
    'crm_order',
    {
      title: 'Yiji order (production)',
      description:
        'A Yiji order via the CRM gateway (GET /commerce/order, vendorId=1): status, payment, brand/branch, items with modifiers.',
      inputSchema: { orderId: z.string().min(1) },
      annotations: RO,
    },
    (a) => answer(() => getOrder(c(), a.orderId)),
  );

  server.registerTool(
    'crm_late_orders',
    {
      title: 'Late delivery orders (production)',
      description:
        "Yiji orders past the late-delivery threshold (GET /commerce/late-orders). No dates = today's LIVE queue; from/to (YYYY-MM-DD) = the register incl. finished orders. live=true marks the range as the current business day (short cache).",
      inputSchema: {
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        live: z.boolean().optional(),
        limit: limit(300, 50),
      },
      annotations: RO,
    },
    (a) => answer(() => lateOrders(c(), a)),
  );

  server.registerTool(
    'crm_agent_activity',
    {
      title: 'Per-agent activity (production)',
      description:
        'For a date range, per agent: chats replied in, replies sent, tickets created, tickets solved, coupons requested. The output states exactly what each number counts.',
      inputSchema: { from: day, to: day },
      annotations: RO,
    },
    (a) => answer(() => agentActivity(c(), a.from, a.to)),
  );

  server.registerTool(
    'crm_ai_usage',
    {
      title: 'AI usage and cost (production)',
      description:
        'From ai_calls: calls, errors, input/output/thinking tokens and est_cost_usd, by Riyadh day, endpoint and model, for a date range.',
      inputSchema: {
        from: day,
        to: day,
        by: z.enum(['day', 'endpoint', 'model', 'all']).optional(),
      },
      annotations: RO,
    },
    (a) => answer(() => aiUsage(c(), a.from, a.to, a.by)),
  );

  server.registerTool(
    'crm_release_status',
    {
      title: 'Production release status',
      description:
        'Newest v* git tag (the prod release) and its subject, compared with origin; and whether the agent portal / chat widget build is parked behind "Update now".',
      inputSchema: {},
      annotations: RO,
    },
    () => answer(() => releaseStatus(deps.repoRoot)),
  );

  server.registerTool(
    'crm_query',
    {
      title: 'Generic read (production)',
      description:
        'Read-only Directus items read: collection, fields (dot paths; no nested *), filter (Directus filter JSON), sort (e.g. ["-date_created"]), limit (default 25, cap 200). System collections refused except directus_users (id, first_name, last_name, email, role, status) and directus_roles (id, name). Secret-looking fields are refused or redacted.',
      inputSchema: {
        collection: z.string(),
        fields: z.array(z.string()).optional(),
        filter: z.record(z.unknown()).optional(),
        sort: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: RO,
    },
    (a) => answer(() => genericQuery(c(), a)),
  );

  return server;
}
