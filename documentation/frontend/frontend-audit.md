# Frontend Architecture Audit — Yiji CRM

**Repository:** `crm-app-frontend` (pnpm monorepo, branch `stream/frontend`)
**Date:** 2026-06-24
**Scope:** Read-only audit of the frontend apps (`apps/`) and shared packages (`packages/`). **No code was modified.**
**Method:** Static inspection of source, configs, Dockerfiles, and git history.

---

## 1. Frontend Applications Discovered

Three applications under `apps/`, plus four shared workspace packages under `packages/`.

| App                    | Framework           | Purpose                                                                                                    | Notable deps                                                             |
| ---------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **@yiji/admin-portal** | React 18.3 + Vite 6 | Admin console: users, teams, SLA policies, vendors, automation, reports, custom fields, imports, AI config | react-router-dom 7, @tanstack/react-query 5, RHF + Zod, @directus/sdk 17 |
| **@yiji/agent-portal** | React 18.3 + Vite 6 | Agent workspace: inbox, conversations, tickets, contacts, AI panel, preferences                            | + socket.io-client 4.8 (realtime)                                        |
| **@yiji/chat-widget**  | Preact 10 + Vite 6  | Embeddable customer chat widget (single IIFE bundle `yiji-chat-widget.js`)                                 | socket.io-client, jose (dev)                                             |

**Shared packages:**

- `@yiji/ui` — design system: primitives, icons, illustrations, `AppShell`, Tailwind preset, Storybook.
- `@yiji/shared-config` — env parsing, Directus **auth client** (`createAuthClient`), service Directus client.
- `@yiji/shared-types` — Zod schemas + domain types: socket events, AI contracts, queues, `YijiClient` (commerce boundary).
- `@yiji/i18n` — i18next base config, locales (`en`/`ar`), RTL helpers (`isRtl`, `dirFor`).

The repo also vendors three Node services (`services/socket-gateway`, `services/workers`, `services/ai-gateway`) and `directus/bootstrap`, but those are **backend** and out of scope except where the frontend integrates with them.

---

## 2. Port Mappings

| App          | Dev port (Vite) | Served/prod port | How served                                                                     |
| ------------ | --------------- | ---------------- | ------------------------------------------------------------------------------ |
| agent-portal | **5173**        | **8090**         | nginx static (SPA) — `yiji-portals` container / portal image                   |
| admin-portal | **5174**        | **8092**         | nginx static (SPA)                                                             |
| chat-widget  | **5175**        | n/a (CDN/embed)  | IIFE bundle hosted on any static origin; dev page proxies `/socket.io` → :8080 |

**Backend ports the frontend talks to** (defaults):

- Directus API: **8055**
- Socket gateway (Socket.IO): **8080**; gateway HTTP (jobs/webhooks): **8081/8082**
- AI gateway: **8081** by default (`VITE_AI_GATEWAY_URL`). _Note:_ in the local hybrid PM2 topology the ai-gateway actually runs on **8085** (see `crm-app/ecosystem.config.cjs`); the `:8081` default reflects the full-Docker compose, so confirm the running topology before assuming.

Dev ports defined in each `apps/*/package.json` `dev` script (`vite --port 517x`) and `vite.config.ts` (`server.port`). Prod ports come from the portal Dockerfiles / nginx (`apps/*/Dockerfile`) and the `yiji-portals` nginx container.

---

## 3. Routing Structure

Both portals use **react-router-dom 7** (`BrowserRouter`), with `AuthProvider` wrapping the router, route-level code-splitting via `React.lazy()`, and an `AppShell` layout for authenticated routes.

### Admin portal — `apps/admin-portal/src/App.tsx`

| Path                                  | Component               | Access            |
| ------------------------------------- | ----------------------- | ----------------- |
| `/login`                              | `Login`                 | public            |
| `/dashboard`                          | `DashboardPage`         | protected (admin) |
| `/users` `/teams` `/vendors`          | Users/Teams/Vendors     | protected         |
| `/sla` `/automation` `/custom-fields` | policy pages            | protected         |
| `/reports` `/sla-reports` `/imports`  | data pages              | protected         |
| `/` and `/*`                          | → redirect `/dashboard` | catch-all         |

Nav groups (in `Shell`): Overview, Workspace, Policies, Data, Intelligence. Gate: `ProtectedRoute` → `isAdmin(user)`.

### Agent portal — `apps/agent-portal/src/App.tsx`

| Path                              | Component                       | Access            |
| --------------------------------- | ------------------------------- | ----------------- |
| `/login`                          | `Login`                         | public            |
| `/`                               | `Inbox`                         | protected (agent) |
| `/tickets` , `/tickets/:ticketId` | `TicketsPage`                   | protected         |
| `/contacts` , `/contacts/:id`     | Contacts / `ContactProfilePage` | protected         |
| `/preferences`                    | `PreferencesPage`               | protected         |
| `/*`                              | → redirect `/`                  | catch-all         |

Nav groups: Work (Inbox, Tickets, Contacts), Account (Preferences). Shell adds notification bell, sound toggle, language toggle. Gate: `ProtectedRoute` → role ∈ `['Agent','Administrator','Admin']`.

### Chat widget

No router — a single Preact modal component (`Widget.tsx`) driven by socket state and custom events.

---

## 4. Shared Component Libraries

### `@yiji/ui` (`packages/ui/src/index.ts`)

- **Layout:** `AppShell` (rail + top bar + collapse context), `Card*`, `Drawer*`, `PageHeader`, `Toolbar`.
- **Forms:** `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `FormField`, `GhostSelect`, `SelectMenu`, `ConfirmDialog`.
- **Display/feedback:** `Spinner`, `Skeleton`, `Pill`, `StatCard`, `EmptyState`, `ErrorState`, `Toast`/`Toaster`/`toast()`, `CommandPalette`, `ShortcutsOverlay`, `SearchTrigger`.
- **Icons & illustrations:** ~15 icons; `InboxEmptyArt`, `TicketEmptyArt`, `ConversationPlaceholderArt`, `BrandMarkArt`, `YijiLogo`.
- **Hooks:** `useFocusTrap`, `useKeyboardShortcuts`, `useMediaQuery`/`useIsDesktop`, `useResizable`.
- **Utils:** `cn`, `formatRelative`, `ErrorBoundary`.
- **Design tokens** (`tailwind-preset.cjs`): OKLCH semantic slots (shadcn-style), rail tokens, overridable `--brand-*`; fixed rem type scale; restrained shadows; Emil-style motion curves + keyframes. Storybook configured.

### `@yiji/shared-config`

Exports `createAuthClient` / `AuthUser` / `browserAuthStorage` (auth), `createServiceClient` (server-side Directus), and Zod env helpers (`parseEnv`, `numericEnv`, `booleanEnv`).

### `@yiji/shared-types`

Domain enums, entities, socket event contracts (`socket.ts`), AI endpoint contracts (`ai.ts`), queue types (`queues.ts`), and the `YijiClient` commerce interface (`yiji.ts`, mock + HTTP impl).

### `@yiji/i18n`

`SUPPORTED_LOCALES = ['en','ar']`, `RTL_LOCALES = ['ar']`, base i18next options + `common` namespace; apps merge app-specific namespaces (`admin`/`agent`).

---

## 5. State Management Approach

No global store (no Redux/Zustand/Jotai). Layered approach:

- **Server state:** TanStack Query 5. `QueryClient` created in each app `main.tsx`. Co-located `features/*/api.ts` modules expose `useX()` queries and `useCreate/Update/DeleteX()` mutations; mutations `invalidateQueries` on success. Query keys are flat/hierarchical (`['users']`, `['ticket', id]`, `['ticket-events', ticketId]`); conditional queries via `enabled`.
- **Auth state:** React Context `AuthContext` (`{ user, loading, login, logout }`), restored on cold load.
- **Forms:** React Hook Form + `zodResolver`; Zod schemas define validation (e.g., Login, UsersPage), `Controller` for complex controls, conditional rules (password required on create, optional on edit).
- **i18n:** i18next (its own provider via `initReactI18next`); language persisted to `localStorage`, `document.dir` updated on change.
- **UI state:** local `useState` (dialogs, focus, selection).

---

## 6. API Integrations

| Integration        | Client file(s)                                                                     | Transport                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------- | -------------------------------------------------------------- |
| **Directus**       | `apps/*/src/lib/directus.ts` + `packages/shared-config/src/auth.ts`                | REST (SDK, cookie auth, `credentials: include`) | CRUD on collections: `conversations`, `messages`(+`messages_files`), `tickets`, `contacts`(+`*_tags`), `tags`, `users`, `teams`, `vendors`, `automation_rules`, `reports`, `custom_fields`. Agent client adds `assetUrl()`/`downloadAsset()`.                                                                                                                                                                |
| **Socket.IO**      | `apps/agent-portal/src/lib/socket.ts`, `apps/chat-widget/src/socket.ts`            | WebSocket/polling                               | Realtime. Agent emits `message:send`, typing, `read:ack`, `note:add/delete`, `csat:submit`, `attachment:upload`, `agent:logout`; listens `message:new`, `typing:update`, `agent:assigned`, `conversation:status_changed`, `presence:update`, `agents:presence`, `notification:pushed`. Widget listens `ready`, `messages:history`, `message:new`, `typing:update`, `agents:presence`, `conversation:closed`. |
| **AI gateway**     | `apps/admin-portal/src/lib/ai-client.ts`, `apps/agent-portal/src/lib/ai-client.ts` | HTTP (Bearer = user Directus token)             | Admin: `GET/PUT /admin/config`, `GET /admin/usage`. Agent: `POST /summarize-conversation`, `/suggest-reply`, `/analyze-sentiment`, `/detect-intent`, `/extract-entities`, `/semantic-search`, `/score-lead`.                                                                                                                                                                                                 |
| **Commerce proxy** | `apps/agent-portal/src/lib/commerce-client.ts`                                     | HTTP via AI gateway (Bearer)                    | `GET /commerce/activity                                                                                                                                                                                                                                                                                                                                                                                      | orders | payment | shipment`; gateway injects the Yiji API key server-side (C-2). |
| **Job producer**   | `apps/admin-portal/src/lib/job-producer.ts`                                        | HTTP (Bearer)                                   | `POST /jobs/import`, `POST /jobs/report` → `{ ok, jobId }`.                                                                                                                                                                                                                                                                                                                                                  |

---

## 7. Authentication Flow

Core in `packages/shared-config/src/auth.ts`; mode is **cookie (H-2)**.

- **Login:** `AuthContext.login()` → `client.login(email,password)` → Directus sets an **httpOnly refresh-token cookie**; access token held **in memory only**. Then `me()` populates the user.
- **`me()`:** `readMe` fetching `id,email,first/last_name,status`, `role{id,name,policies.policy.admin_access}`, and direct `policies.policy.admin_access`. Computes `admin_access` from policies (Directus 11 authoritative signal).
- **Cold-load restore:** `AuthContext` mount → `auth.restore()` → `client.refresh()` (from cookie) → `me()`; null ⇒ redirect to `/login`.
- **Authorization gating (client-side, UX):**
  - Admin: `isAdmin(user)` = `admin_access` OR role name ∈ `['Administrator','Admin']` (`AuthContext.tsx`, `ProtectedRoute.tsx`).
  - Agent: role ∈ `['Agent','Administrator','Admin']`.
- **Logout:** admin → `client.logout()` + clear user; agent → `disconnectSocket()` (emits `agent:logout`) **first**, then logout.
- **Socket auth:** agent sends `{ kind:'agent', token }` via an auth **callback** that re-fetches the token on every (re)connect (auto-refresh); on auth-related `connect_error` it fires a session-expired handler (toast + logout, disables reconnection). Widget sends `{ kind:'customer', token }` (static Yiji JWT); on auth error after >30s it reloads to re-mint.
- **Cross-origin requirement:** cookie-mode needs Directus `CORS_CREDENTIALS=true` + a non-Secure, SameSite=Lax refresh cookie on local http. (This was a live misconfiguration earlier in deployment; see Technical Debt.)

---

## 8. Environment Variables

All `VITE_*` vars are **baked at build time** into the client bundle — only non-secret values belong here.

| Variable                  | Default                                        | Used by              | Purpose                                                                                 |
| ------------------------- | ---------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `VITE_DIRECTUS_URL`       | `http://localhost:8055`                        | all                  | Directus API base                                                                       |
| `VITE_SOCKET_URL`         | `http://localhost:8080`                        | agent, widget        | Socket.IO gateway origin                                                                |
| `VITE_AI_GATEWAY_URL`     | `http://localhost:8081`                        | admin, agent         | AI + commerce gateway                                                                   |
| `VITE_JOB_PRODUCER_URL`   | `http://localhost:3031` (dev) / `:8082` (prod) | admin                | Import/report enqueue endpoint                                                          |
| `VITE_JOB_PRODUCER_TOKEN` | `''`                                           | admin                | Dev-only producer token (empty in prod)                                                 |
| `VITE_YIJI_API_URL`       | `''`                                           | agent (build arg)    | Commerce API base (optional)                                                            |
| `VITE_WIDGET_JWT_SECRET`  | `'dev-yiji-secret'` (fallback)                 | widget (dev/QA only) | Signs the local demo customer JWT — **must never be set in a real build** (see §11/§14) |

Backend (non-`VITE_`, runtime only): `DIRECTUS_*`, `DB_*`, `REDIS_URL`, `YIJI_JWT_SECRET`, `SVC_GATEWAY_TOKEN`/`SVC_WORKERS_TOKEN`/`SVC_AI_TOKEN`, `CORS_ORIGIN`/`WIDGET_CORS_ORIGIN`, `GEMINI_*`, `SMTP_*`, `YIJI_WEBHOOK_SECRET`, `OTEL_*`. Templates: `.env.example`, `.env.prod.example`.

---

## 9. Build Process

- **Toolchain:** Vite 6 + TypeScript 5.7 (strict, ES2022, bundler resolution; base `tsconfig.base.json`, per-app JSX overrides).
- **Portals:** `tsc -b && vite build` → `dist/` (SPA). Multi-stage Dockerfile: node:20-alpine build (pnpm `--frozen-lockfile`, `VITE_*` baked as build args) → nginx:1.27-alpine static serve on :80 with SPA fallback + security headers + `/health`.
- **Widget:** `tsc --noEmit && vite build` in **Vite lib mode** → IIFE `yiji-chat-widget.js` (+ css). esbuild automatic JSX (`jsxImportSource: preact`) instead of `@preact/preset-vite` (Windows ESM bug). A `widgetHostPage()` plugin generates a demo `index.html` (with an inline JWT mint) **for local/QA only** — stripped from production builds.
- **Verified this session:** lint clean; both portals build; typecheck clean on shared-config / socket-gateway / admin-portal / agent-portal; unit suites pass (admin 83, agent 143, socket-gateway 117).

---

## 10. Development Workflow

- **Monorepo:** pnpm workspaces (`pnpm-workspace.yaml`: `apps/*`, `services/*`, `packages/*`, `directus/bootstrap`).
- **Root scripts:** `lint`, `lint:fix`, `format`/`format:check`, `typecheck` (`pnpm -r`), `build` (`pnpm -r`), `test` (root vitest + `pnpm -r test`), `test:watch`, `test:e2e` (Playwright), `test:e2e:local`, `test:coverage`, `dev` (`pnpm -r --parallel dev`).
- **Quality gates:** ESLint (TS recommended + prettier), Prettier (width 100, single quotes, trailing commas, LF). Husky pre-commit → lint-staged (eslint --fix + prettier on staged; skips `*.config.*`).
- **Run locally:** `pnpm install`; bring up backend (full Docker `docker compose --profile app up -d`, or hybrid: Docker infra + PM2 services); then `pnpm --filter @yiji/<app> dev` (5173/5174/5175). E2E has a safe isolated harness (`test:e2e:local`) on `:8066`.
- **Platform notes:** dev machine is RAM-tight — prefer single-worker test runs + a Node heap flag; pnpm lifecycle scripts need PowerShell (node not on PATH in Git-Bash subshells).

---

## 11. Technical Debt

Overall discipline is high — **no `TODO`/`FIXME`/`HACK` markers in app code**, no `@ts-ignore`, minimal/justified suppressions. Real items:

1. **Cross-portal duplication (largest item).** `AuthContext.tsx`, `ProtectedRoute.tsx`, `Login.tsx`, `LanguageToggle`, `AppCommandPalette`, `AppKeyboardShortcuts`, `directus.ts`, `RouteError`, and `App.tsx` shells are ~90% duplicated between admin- and agent-portal. No shared "portal-shell" package — fixes must be applied twice (~hundreds of LOC of drift risk).
2. **Type coercions around Directus shapes.** Repeated `as unknown as {...}` for the conversation `vendor` field (`ConversationSidebar.tsx`, `ConversationToolbar.tsx`) and ticket attachment mapping (`tickets/api.ts`) — the Directus response schema for these isn't reflected in shared types.
3. **Windows build workarounds.** Widget uses esbuild JSX instead of `@preact/preset-vite`; all three apps keep a separate `vitest.config.ts` to avoid importing `vite.config.ts` (esbuild config-bundling crash). Documented and intentional, but a maintenance tax (no widget HMR; config drift risk).
4. **Deployment/auth config fragility (resolved live, worth hardening in code).** Cookie-mode auth requires Directus `CORS_CREDENTIALS=true` + `REFRESH_TOKEN_COOKIE_SECURE=false`/`SAME_SITE=lax` on local http; a stale Directus container missing these produced recurring "no administrator access." There is no client-side guard/diagnostic for a failed cross-origin refresh.
5. **No build-time secret guard.** Nothing fails the build if a `VITE_*` var (esp. `VITE_WIDGET_JWT_SECRET`, `VITE_JOB_PRODUCER_TOKEN`) is set to a real secret and thus baked into the client bundle.

---

## 12. Features Currently Incomplete

No placeholder pages, "coming soon" UI, dead buttons, `NotImplemented`, or mock data in production paths were found — every page fetches real data.

The only "disabled" surface is **intentional and complete**: AI features are toggled per vendor in `AiConfigPage`, and the agent `AiPanel` degrades gracefully (`feature_disabled` → "Disabled by admin."). That's a feature, not a gap.

Effective "incompleteness" is the **deployment-readiness gap**, not UI: production cutover still needs real secrets/DNS/TLS/SMTP/managed datastores and a staging verification pass (tracked separately in `crm-app/docs/GO-LIVE-READINESS.md`).

---

## 13. Features Currently In Progress

From git history and branch state (point-in-time):

- **Active branch:** `stream/frontend` (and a transient `fix/e2e-tickets-first-response`).
- **Recently landed / converging:** security hardening (H-2 cookie auth, C-2 server-side commerce proxy removing the browser API token, CSP), bootstrap idempotence + E2E selector-drift fixes, deploy-architecture consolidation (Docker infra + PM2 services + nginx edge), Linux frontend build + stripping the widget demo page from prod, and (this session) portal SPA `no-cache` headers + gating the infra compose app services behind a profile.
- **Open PRs at audit time:** cache-header fix into the `001` deploy branch (merged as PR #30) and the infra Compose-profile fix (PR #33, open).

No half-wired scaffolding or dangling feature stubs were found in `src/`.

---

## 14. Areas That Should Belong to Backend Rather Than Frontend

| Area                                      | Where                                                             | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser JWT minting (dev)**             | `apps/chat-widget/src/demo.ts`, `vite.config.ts` host-page plugin | Signs a customer JWT in the browser with a shared secret. **DEV/QA only** and stripped from prod builds — but there's **no build-time assertion** preventing a real `YIJI_JWT_SECRET`/`VITE_WIDGET_JWT_SECRET` from being baked in. In production the platform must mint and hand the widget a pre-signed token. _Recommend a build guard._                                                                                                                                                          |
| **Direct Directus CRUD from the browser** | `apps/*/features/*/api.ts`                                        | Admin/agent mutate `vendors`, `automation_rules`, `sla`, `custom_fields`, `users`, etc. directly via the Directus SDK. Authorization rests entirely on **Directus collection permissions** — there is no domain API enforcing business rules, tenant ownership, or server-side audit beyond Directus' own activity log. Functional today, but business logic + authorization for admin operations arguably belong behind an API. _Medium risk; depends on Directus permission config being correct._ |
| **Client-side role gating**               | `ProtectedRoute.tsx` (both portals)                               | UX-only, which is correct — the AI/commerce/job endpoints re-verify the Directus token server-side and the gateway derives admin status server-side. **Not a vulnerability**, provided Directus permissions back it.                                                                                                                                                                                                                                                                                 |
| **Baked client config/tokens**            | `VITE_*` build args                                               | Only URLs are exposed today (safe). `VITE_JOB_PRODUCER_TOKEN`/`VITE_WIDGET_JWT_SECRET` are dev-only and empty/placeholder in prod, but nothing enforces that.                                                                                                                                                                                                                                                                                                                                        |
| **PII inside the customer JWT**           | widget token (`vendor_id`, `customer_id`, phone, email, name)     | Acceptable (customer's own data, in memory, over the socket handshake) — provided the gateway validates the signature and rate-limits contact upserts. Avoid logging the token.                                                                                                                                                                                                                                                                                                                      |
| **Attachment upload**                     | `apps/agent-portal/src/lib/socket.ts`                             | Goes through the gateway (not direct-to-Directus); gateway enforces MIME/size. Correctly server-mediated.                                                                                                                                                                                                                                                                                                                                                                                            |

---

## Summary

The frontend is a well-disciplined React/Preact + Vite monorepo with a coherent design system, clean state model (TanStack Query + Context + RHF/Zod), security-conscious cookie-mode auth, and active maintenance. The **top opportunities** are: (1) extract a shared portal-shell package to kill admin/agent duplication, (2) add an admin domain API (or formally audit/lock Directus permissions) so the browser isn't the only authorization layer, (3) add build-time guards against baking secrets into `VITE_*` and against shipping the widget's dev JWT mint, and (4) tighten the Directus response types to remove `as unknown as` coercions. Incomplete work is deployment/ops-side (secrets, DNS, TLS, staging sign-off), not UI.

_Generated by a read-only multi-agent audit. No source files were modified._
