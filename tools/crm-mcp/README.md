# crm-mcp: the CRM as a Claude Code connector (PRODUCTION, read-only)

An MCP server that lets Claude Code read the **production** Sara/Yiji CRM at
`https://crm-api.anan.sa`: chats, tickets, coupons, Yiji orders, late orders,
agent activity, AI usage and release status.

- **Production only.** There is no staging mode, so you never have to ask
  which system an answer came from. Every tool result starts with this line:
  `[PRODUCTION · read-only · crm-api.anan.sa]`
- **Read-only, enforced in code.** All HTTP goes through one function,
  `readOnlyFetch` in `src/guard.ts`. It allows `GET` and exactly two `POST`s,
  `/auth/login` and `/auth/refresh`, which open and renew the session. Any
  other request throws before it is sent, and requests can only go to
  `crm-api.anan.sa`. `test/guard.test.ts` covers this.
- **Credentials** are `DIRECTUS_ADMIN_EMAIL` / `DIRECTUS_ADMIN_PASSWORD` from
  the git-ignored `.env.prod.smoke` at the repo root. The server parses that
  file and does not source it. It finds the file by walking up from the
  package, so a worktree build still uses the main checkout's copy. To use a
  different file, set `CRM_MCP_ENV_FILE`. Credentials and tokens are never
  logged, returned or put into error messages. If a request gets a 401, the
  server renews the session and retries once.

## Tools

| Tool                       | What it answers                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_search_conversations` | Chats by phone (in any format) or name fragment, status and last-message date range                                                                                                                                 |
| `crm_get_conversation`     | One chat: SLA, linked tickets and messages. Deleted and edited messages are marked, and internal notes are flagged.                                                                                                 |
| `crm_search_tickets`       | Tickets by id, order id, phone, subject/description text, status and created-date range                                                                                                                             |
| `crm_get_ticket`           | Ticket detail, the `ticket_events` timeline and its coupon requests                                                                                                                                                 |
| `crm_coupons`              | `coupon_approvals` by code, phone, order, status or date: terms, the Yiji ids, push errors, and who requested and decided                                                                                           |
| `crm_order`                | A Yiji order through `GET /commerce/order` (vendorId=1): items with modifiers, payment and branch                                                                                                                   |
| `crm_late_orders`          | `GET /commerce/late-orders`: with no dates, today's live queue; with `from`/`to`, the register                                                                                                                      |
| `crm_agent_activity`       | Per agent: chats replied in, replies, tickets created and solved, coupons requested. The result says what each number counts.                                                                                       |
| `crm_ai_usage`             | `ai_calls`: calls, tokens and `est_cost_usd` by day, endpoint and model                                                                                                                                             |
| `crm_release_status`       | Newest `v*` tag and its subject, compared with origin, and whether the agent portal or widget is parked behind "Update now" (uses `scripts/check-portal-promoted.mjs`)                                              |
| `crm_query`                | A generic Directus read (collection, fields, filter, sort, limit up to 200). System collections are refused except `directus_users` (safe fields only) and `directus_roles`. Secret fields are refused or redacted. |

Dates are Riyadh days (`YYYY-MM-DD`, inclusive). Times are shown in Riyadh time
with UTC in brackets. Phones are shown as stored (`05XXXXXXXX`).

## Build

```powershell
pnpm install
pnpm --filter @yiji/crm-mcp build      # -> tools/crm-mcp/dist/index.js
pnpm --filter @yiji/crm-mcp test
pnpm --filter @yiji/crm-mcp smoke      # lists tools, calls crm_release_status + crm_query vendors limit 1
```

`dist/` is git-ignored, so build after every pull that changes this package.

## Register with Claude Code

Run this once from any directory:

```powershell
claude mcp add crm-prod -- node D:/emad/Afcoapp/ProgramFile/claudeCode/crm-app/tools/crm-mcp/dist/index.js
```

To make it available in every project, add `--scope user` after `add`.
Inside Claude Code, run `/mcp` to see whether `crm-prod` is connected.

To remove it:

```powershell
claude mcp remove crm-prod
```

If you registered it with `--scope user`, remove it with
`claude mcp remove crm-prod --scope user`.
