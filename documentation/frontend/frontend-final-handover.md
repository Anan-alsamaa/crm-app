# Frontend Final Handover — Yiji CRM

**Date:** 2026-06-24
**Repo:** `Anan-alsamaa/crm-app` (monorepo). The frontend lives under `apps/` + `packages/`.
**Source of truth:** branch `001-yiji-crm-platform` → `main`. (`stream/frontend` is a stale integration branch — see [frontend-convergence-report.md](./frontend-convergence-report.md): 001 is strictly ahead, nothing stranded.)
**Companion docs:** [`frontend-audit.md`](./frontend-audit.md) (deep architecture), [`frontend-convergence-report.md`](./frontend-convergence-report.md) (branch convergence), `crm-app/docs/GO-LIVE-READINESS.md` (cutover gate).

This is the cold-start handover: what the frontend is, how the two portals and the widget are built, how to deploy them, and what to watch out for.

---

## 1. Frontend Architecture

A pnpm-workspace monorepo, TypeScript **strict** throughout, built with **Vite 6**. Three apps consume four shared packages.

### Apps

| App                    | Stack                                  | Purpose                                                                                                          |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **@yiji/admin-portal** | React 18.3 + Vite 6                    | Admin console: users, teams, vendors, SLA policies, automation rules, custom fields, reports, imports, AI config |
| **@yiji/agent-portal** | React 18.3 + Vite 6 + socket.io-client | Agent workspace: inbox, conversations (realtime), tickets, contacts, AI panel, preferences                       |
| **@yiji/chat-widget**  | Preact 10 + Vite 6 (IIFE bundle)       | Embeddable customer chat widget                                                                                  |

### Shared packages

- **@yiji/ui** — design system: `AppShell`, cards/drawers/toolbars, forms, feedback (`Toast`, `Spinner`, `EmptyState`), `CommandPalette`, icons/illustrations, hooks (`useFocusTrap`, `useKeyboardShortcuts`), and the **Tailwind preset** (OKLCH semantic tokens, overridable `--brand-*`). Storybook configured.
- **@yiji/shared-config** — `createAuthClient` (Directus cookie auth), `createServiceClient` (server-side), Zod env helpers.
- **@yiji/shared-types** — domain enums/entities, **Socket.IO event contracts** (`socket.ts`), AI contracts (`ai.ts`), queue types, and the `YijiClient` commerce interface (mock + HTTP).
- **@yiji/i18n** — i18next base config, locales `en`/`ar`, RTL helpers (`isRtl`, `dirFor`). Arabic is full RTL.

### Cross-cutting model

- **Server state:** TanStack Query 5. No global store (no Redux/Zustand). Co-located `features/*/api.ts` modules expose `useX()` queries + `useCreate/Update/DeleteX()` mutations that `invalidateQueries` on success.
- **Auth state:** React Context (`AuthContext`), restored on cold load via refresh-cookie.
- **Forms:** React Hook Form + Zod (`zodResolver`).
- **Routing:** react-router-dom 7, `BrowserRouter`, route-level `React.lazy()` code-splitting, `AppShell` layout for authenticated routes.
- **i18n / UI:** i18next provider; language persisted to `localStorage`; `document.dir` flips for RTL. Local component state via `useState`.

### Integrations (all from the browser)

| Integration                    | Transport                                          | Notes                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Directus**                   | REST SDK, **cookie auth** (`credentials: include`) | Direct CRUD on collections (conversations, messages, tickets, contacts, tags, users, teams, vendors, automation_rules, reports, custom_fields). AuthZ rests on Directus collection permissions. |
| **Socket.IO** (agent + widget) | WebSocket/polling                                  | Realtime messaging, typing, presence, notifications, CSAT, attachment upload. Event contracts in `@yiji/shared-types/socket.ts`.                                                                |
| **AI gateway**                 | HTTP, Bearer = user Directus token                 | summarize / suggest-reply / sentiment / intent / entities / semantic-search / lead-score; admin config + usage.                                                                                 |
| **Commerce proxy**             | HTTP via AI gateway                                | `GET /commerce/*`; gateway injects the Yiji API key **server-side** (browser never holds it — security item C-2).                                                                               |
| **Job producer**               | HTTP, Bearer                                       | admin `POST /jobs/import`, `/jobs/report` → `{ ok, jobId }`.                                                                                                                                    |

---

## 2. Portal Architecture (admin + agent)

Both portals are the **same shape**: `AuthProvider` → `BrowserRouter` → public `/login` + protected routes inside `AppShell`. Route guard is `ProtectedRoute` (UX-only; server re-verifies).

### Admin portal

- **Routes:** `/login` (public); `/dashboard`, `/users`, `/teams`, `/vendors`, `/sla`, `/automation`, `/custom-fields`, `/reports`, `/sla-reports`, `/imports` (protected); `/` + `/*` → `/dashboard`.
- **Nav groups:** Overview · Workspace · Policies · Data · Intelligence.
- **Gate:** `isAdmin(user)` = Directus `admin_access` policy **OR** role name ∈ `['Administrator','Admin']`.

### Agent portal

- **Routes:** `/login` (public); `/` (Inbox), `/tickets` + `/tickets/:ticketId`, `/contacts` + `/contacts/:id`, `/preferences` (protected); `/*` → `/`.
- **Nav groups:** Work (Inbox, Tickets, Contacts) · Account. Shell adds notification bell, sound toggle, language toggle.
- **Gate:** role ∈ `['Agent','Administrator','Admin']`.
- **Realtime:** `lib/socket.ts` — auth via callback that re-fetches the token on every (re)connect; on auth `connect_error` → session-expired handler (toast + logout, reconnection disabled). Logout disconnects the socket (`agent:logout`) **before** clearing auth.

### Auth flow (shared, cookie-mode "H-2")

1. **Login** → `client.login()` → Directus sets an **httpOnly refresh cookie**; access token stays **in memory only** → `me()` populates the user.
2. **Cold-load restore** → `auth.restore()` → `client.refresh()` (from cookie) → `me()`; null ⇒ `/login`.
3. **`me()`** reads role + `policies.policy.admin_access` (Directus 11 authoritative admin signal).
4. **Cross-origin requirement:** Directus must run with `CORS_CREDENTIALS=true` and, on local http, `REFRESH_TOKEN_COOKIE_SECURE=false` + `SAME_SITE=lax`. _(See Known Issues — this was a recurring live misconfig.)_

### Ports

| Portal       | Dev (Vite) | Prod (nginx) |
| ------------ | ---------- | ------------ |
| agent-portal | **5173**   | **8090**     |
| admin-portal | **5174**   | **8092**     |

### Serving

Multi-stage Dockerfile per portal: `node:20-alpine` build (pnpm `--frozen-lockfile`, `VITE_*` baked as build args) → **nginx:1.27-alpine** static serve with SPA fallback, security headers (CSP/HSTS), `/health`, and **no-cache on the SPA shell + immutable `/assets/`** (so users never get a stale `index.html` pinned to a deleted bundle).

---

## 3. Widget Architecture (chat-widget)

- **Framework:** Preact 10, built in **Vite library mode** → a single **IIFE** `yiji-chat-widget.js` (+ css). Designed to be dropped on any host page / CDN and embedded.
- **No router** — one modal component (`Widget.tsx`) driven by socket state and custom events. Branded per vendor (colors/logo), greets the customer by name.
- **Realtime:** `src/socket.ts` connects to the gateway as `{ kind:'customer', token }` (a signed Yiji JWT carrying `vendor_id`, `customer_id`, name/contact). Listens `ready`, `messages:history`, `message:new`, `typing:update`, `agents:presence`, `conversation:closed`; supports attachments and the **CSAT survey** on close. On an auth error after >30s it reloads to re-mint the token.
- **Customer identity:** customers are **never CRM users** — the host platform passes a pre-signed JWT; the gateway validates the signature and upserts the contact.
- **Dev/QA host page:** a `widgetHostPage()` Vite plugin generates a demo `index.html` that **mints a JWT in the browser** using `VITE_WIDGET_JWT_SECRET`. This is **dev/QA only and is stripped from production builds**. ⚠️ In production the host platform mints the token server-side — the widget secret must never reach a real build (no build-time guard exists yet — see Known Issues).
- **Dev port:** **5175**; the dev page proxies `/socket.io` → `:8080`.
- **Windows note:** uses **esbuild automatic JSX** (`jsxImportSource: preact`) instead of `@preact/preset-vite` (a Windows ESM bug breaks the preset). Trade-off: no widget HMR. Intentional — **do not revert.**
- **Bundle budget:** gzipped target **< 50 KB** (spec SC-011; checked in the perf audit).

---

## 4. Deployment Notes

### Topologies

- **Full Docker:** `cd crm-app-infra && docker compose --profile app up -d` brings up infra **and** the Node services in containers.
- **Hybrid (local prod rehearsal):** Docker **infra only** (`docker compose up -d` → postgres/redis/directus) + **PM2** app services (`crm-app/ecosystem.config.cjs`) + **nginx** edge for portals. The infra compose app services are gated behind the `app` profile **specifically so a bare `up` doesn't collide with PM2** (port 8080 bind clash / duplicate worker double-consuming the queue). Helpers: `start-infra.ps1` / `stop-infra.ps1`.

### Building the frontends for prod

- Linux/CI path: **`bash deploy/build-frontend.sh`** (from repo root with `.env.prod`'s `VITE_*` exported) — builds agent/admin/widget and **strips the widget dev demo page**. Point nginx at the `dist/` dirs.
- `build-frontend.ps1` is a **Windows local-demo helper only** — it bakes the widget JWT secret to mint a browser demo token. **Never use it for a public deploy.**
- **Rebuild whenever `VITE_*` (the domain) or frontend code changes** — those URLs are compiled into the bundle.

### `VITE_*` environment (baked at build time — non-secret only)

| Var                       | Default                            | Used by                                |
| ------------------------- | ---------------------------------- | -------------------------------------- |
| `VITE_DIRECTUS_URL`       | `http://localhost:8055`            | all                                    |
| `VITE_SOCKET_URL`         | `http://localhost:8080`            | agent, widget                          |
| `VITE_AI_GATEWAY_URL`     | `http://localhost:8081`            | admin, agent                           |
| `VITE_JOB_PRODUCER_URL`   | dev `:3031` / prod gateway `:8082` | admin                                  |
| `VITE_JOB_PRODUCER_TOKEN` | `''` (empty in prod)               | admin                                  |
| `VITE_YIJI_API_URL`       | `''`                               | agent                                  |
| `VITE_WIDGET_JWT_SECRET`  | dev fallback                       | widget — **never set in a real build** |

> **Port gotcha:** the `VITE_AI_GATEWAY_URL` default `:8081` reflects full-Docker compose. In the local **hybrid PM2** topology the ai-gateway runs on **:8085**. Confirm the running topology before assuming.

### Cutover checklist (frontend-relevant)

- Rotate every secret; set `CORS_ORIGIN` to the exact portal hostnames (prod guard rejects `*`).
- TLS in front of every HTTP service; **WebSockets over WSS with sticky sessions**; CSP + HSTS at the portal/widget CDN layer.
- Verify the LB exposes only `/jobs/*` (+ `/webhooks/*`) publicly; keep `/metrics` + `/debug/*` internal.
- Run `pnpm test:e2e` (Playwright) + the load test against **staging** before promoting. Full gate: `crm-app/docs/GO-LIVE-READINESS.md`.

### Quality gates (CI on every push)

`pnpm lint && pnpm typecheck && pnpm test` then `pnpm test:e2e`. On the RAM-tight dev box prefer single-worker runs + a Node heap flag; pnpm lifecycle scripts need **PowerShell** (node isn't on PATH in Git-Bash subshells).

---

## 5. Known Issues

**Code discipline is high** — no `TODO`/`FIXME`/`HACK` in app code, no `@ts-ignore`, no placeholder/"coming soon" pages, no mock data in prod paths. The open items are architectural and operational, not feature gaps.

1. **Cross-portal duplication (largest item).** `AuthContext`, `ProtectedRoute`, `Login`, `LanguageToggle`, command-palette/shortcuts, `directus.ts`, and the `App.tsx` shell are ~90% duplicated between admin- and agent-portal. No shared "portal-shell" package → fixes must be applied twice (drift risk). **Top refactor candidate.**

2. **Directus type coercions.** Repeated `as unknown as {...}` around the conversation `vendor` field and ticket-attachment mapping — the Directus response shapes aren't reflected in `@yiji/shared-types`. Tighten the types to remove the casts.

3. **No build-time secret guard.** Nothing fails the build if `VITE_WIDGET_JWT_SECRET` or `VITE_JOB_PRODUCER_TOKEN` is set to a real secret and baked into the client bundle. **Add a guard** before public deploys (most important for the widget JWT mint).

4. **Auth/CORS config fragility (resolved live, not yet hardened in code).** Cookie-mode auth needs `CORS_CREDENTIALS=true` + non-Secure/Lax refresh cookie on local http. A stale Directus container missing these env vars produced recurring **"Your account does not have administrator access."** Fix is recreating Directus with the correct env (compose already has it). There's **no client-side diagnostic** for a failed cross-origin refresh — a user just sees the access error.

5. **Browser does direct Directus CRUD (authorization design).** Admin/agent mutate `vendors`, `automation_rules`, `sla`, `custom_fields`, `users`, etc. directly via the SDK. AuthZ rests **entirely on Directus collection permissions** — there's no domain API enforcing business rules / tenant ownership / server-side audit beyond Directus' activity log. Functional today; revisit if admin business logic needs server-side enforcement. (AI/commerce/job endpoints **do** re-verify server-side, so client role gating there is correctly UX-only.)

6. **Windows build workarounds (maintenance tax, intentional).** Widget uses esbuild JSX (no HMR); all three apps keep a separate `vitest.config.ts` to avoid an esbuild config-bundling crash on Windows. Documented; don't "simplify" without testing on Windows. chat-widget has **no unit tests** (e2e only) — its vitest fails locally on Windows via a broken `@preact/preset-vite` symlink; Linux CI is fine.

7. **The four working dirs are one repo.** `crm-app`, `crm-app-frontend`, `crm-app-infra`, `crm-app-quality` are checkouts of the **same** GitHub repo on different branches. A branch "moving on its own" = pushes from a sibling checkout, not a mystery — `git fetch` and check. `stream/frontend` is stale vs `001`/`main`; treat **001** as truth.

### Not a bug

AI features toggle per vendor (`AiConfigPage`); the agent `AiPanel` degrades gracefully (`feature_disabled` → "Disabled by admin."). That's intended behavior. The real remaining "incompleteness" is **deployment/ops** (secrets, DNS, TLS, SMTP, managed Postgres/Redis, staging sign-off), tracked in `GO-LIVE-READINESS.md` — **not** the frontend code.

---

_Read-only handover. No source files were modified. Derived from `frontend-audit.md`, `frontend-convergence-report.md`, the session export, and a fresh inspection of the workspace on branch `fix/e2e-tickets-first-response` (frontend source identical to `001`/`main`)._
