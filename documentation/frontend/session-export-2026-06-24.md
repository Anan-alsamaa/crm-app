# Session Memory Export — Yiji CRM

**Exported:** 2026-06-24
**Scope:** Complete context accumulated across the entire Claude Code session (not just recent work).
**Assumption:** The live session will be deleted after this export; everything important is captured here.
**Primary working dirs:** `crm-app-frontend` (frontend stream), `crm-app` (main/deploy), `crm-app-infra` (infra), `crm-app-quality` (quality).

> Cross-reference: persistent memory files were also written this session — `shared-remote-working-dirs.md`, `directus-cookie-auth-stale-container.md`, and an update to `stray-docker-stack-conflict.md` (indexed in `MEMORY.md`). This document is the fuller narrative.

---

## 0. The single most important discovery (read first)

**`crm-app`, `crm-app-frontend`, `crm-app-infra`, `crm-app-quality` are four working copies of the SAME GitHub repo** (`https://github.com/Anan-alsamaa/crm-app.git`), each checked out to a different branch:

- `crm-app` → `main`
- `crm-app-frontend` → `stream/frontend`
- `crm-app-infra` → a deploy/feature branch (`deploy/linux-build-frontend` at audit time)
- `crm-app-quality` → `stream/quality`

**Consequence:** When a branch "moves on its own" mid-session, it is **pushes from a sibling checkout** (the user working in another dir, or a parallel automated agent), NOT a mystery. `main` advanced several times during this session this way (e.g. `409e50b → 6542915 → 9559a87`, and `001` `ecd655c → 8bd73ba`). Always `git fetch` and check before assuming a conflict or a clean state. Convergence into the release branch happens via PRs (#26–#33 observed).

---

## 1. Architectural decisions made (this session)

These were decided/confirmed during the session:

1. **Portal SPA shell must be served `no-cache`; `/assets/*` immutable.** Browsers were holding a stale `index.html` pointing at an old hashed bundle ("fixes not applying"). Applied to: the live `yiji-portals` nginx (`crm-app/deploy/nginx.local.conf`, gitignored), both portal Dockerfiles (`crm-app` and `crm-app-frontend`), and the edge config `crm-app/deploy/nginx/yiji-crm.conf`. Security headers must be **repeated per-`location`** because an `add_header` inside a location cancels inheritance of server-level headers (nginx behavior).

2. **Gate the infra-compose app services behind a Compose `app` profile.** `crm-app-infra/docker-compose.yml` defines BOTH infra (postgres/redis/directus) AND app services (socket-gateway/ai-gateway/workers). In the hybrid local topology the app tier runs under PM2, so a bare `docker compose up -d` started Docker copies that collided with PM2. Fix: `profiles: ['app']` on the three app services → bare `up` = infra only; `--profile app up` = full Docker stack. (PR #33, open.)

3. **Directus must be configured for cookie-mode auth on local http.** The H-2 auth design requires Directus `CORS_CREDENTIALS=true`, `REFRESH_TOKEN_COOKIE_SAME_SITE=lax`, `REFRESH_TOKEN_COOKIE_SECURE=false`. The compose already had these; the **running container was stale** and lacked them → recreated the container.

4. **Hybrid local topology is canonical for local prod-rehearsal:** Docker = infra (postgres 5433, redis 6380, directus 8055), PM2 = app services (`crm-app/ecosystem.config.cjs` → socket-gateway 8080/8081, ai-gateway **8085**, workers), nginx = portals (`yiji-portals` container, agent :8090, admin :8092). Widget runs via Vite dev on :5175 + ngrok.

5. **Deploy source-of-truth branch is `001-yiji-crm-platform`** (per `crm-app/docs/DEPLOYMENT.md`), NOT `main` or `stream/frontend`. Cache/infra fixes must reach `001` (via PR) to affect a real deploy.

6. **Design (impeccable skill) for the chat widget host page is "mobile app-style, settings-list" + WCAG AA.** The widget is explicitly out-of-scope of the portals' `PRODUCT.md` (separate consumer-facing aesthetic, branded per tenant).

---

## 2. Decisions later reversed / superseded

1. **Admin-access root cause: "browser cache" → corrected to "stale Directus container."** Initial diagnosis (correct but incomplete) was a stale cached bundle + missing `no-cache`. When it recurred, the deeper root cause was found: the running Directus container predated the cookie/CORS env in the compose, so session refresh failed after the 15-min token. The cache fix was still valid, but it was not the whole story.

2. **`DEPLOY-HYBRID.md` cache-header edit was discarded.** I edited `crm-app/docs/DEPLOY-HYBRID.md` to add the no-cache nginx blocks; a parallel "final architecture kit" commit (`409e50b`) **retired that file entirely** (deleted DEPLOY-HYBRID.md, Caddyfile, docker-compose.proxy.yml), replacing it with `deploy/nginx/yiji-crm.conf`. The fix was re-applied to the surviving artifacts (edge config + Dockerfiles).

3. **"Stand down" on the PR #27 conflicted merge → reversed by the user → then moot.** I first refused to touch a conflicted in-progress merge (correct, since a parallel actor owned it). The user later authorized resolving it; by then the parallel actor had already completed it (`734f902`), so I only verified correctness (typecheck + tests) rather than resolving.

---

## 3. Important discoveries

- **Shared-remote topology** (see §0) — the root cause of all "branch moved" confusion.
- **The `yiji-portals` nginx serves portal builds from `crm-app/apps/*/dist`** (bind-mounted, read-only), NOT from `crm-app-frontend`. So a fix in `crm-app-frontend` does not appear at :8090/:8092 until it reaches `crm-app`'s branch and that `dist` is rebuilt.
- **`crm-app/.env.prod` is the LOCAL prod-rehearsal env**, not a production cutover file. It reuses the running Directus's service tokens + JWT (comment: "do NOT regenerate — would break auth") and points at the Docker infra (redis 6380, directus 8055). **Do not overwrite it.**
- **The ngrok free static domain is persistent** and already baked into `crm-app-frontend/apps/chat-widget/.env.local` as `VITE_SOCKET_URL` (`https://jeane-bootyless-undesigningly.ngrok-free.dev`). The widget dev page (`demo.ts`) reads `import.meta.env.VITE_SOCKET_URL`, so the socket routes ngrok → vite :5175 → `/socket.io` proxy → gateway :8080.
- **The "no admin access" gate** (`ProtectedRoute`) only shows when `user` is non-null but `isAdmin` is false — otherwise it redirects to `/login`. `isAdmin = admin_access || role.name ∈ [Administrator, Admin]`. Data is correct: `e.habibi@anan.sa` = role **Administrator**, `admin_access=true` (user id `6eba5cb8-fe09-46c8-a355-acf6f4470b70`, role id `68a31419-487e-4f8b-a4ec-2252ea935476`).
- **Compose vs running-container drift is a real failure mode here** — the compose file can be correct while the running container is stale.
- **A parallel actor committed the widget design fixes** (CTA two-line fix + a11y) as `066721a "fix(widget): accessibility + WCAG AA contrast pass"` — I did not commit them myself.

---

## 4. Assumptions currently relied upon

- The local run is the **hybrid topology** (Docker infra + PM2 apps + nginx portals). If someone runs the full Docker stack instead, ports collide unless the PM2 stack is stopped.
- **`001-yiji-crm-platform` is the deploy branch.**
- The shared remote is the single source of truth; all four dirs push/pull from it.
- The ngrok static domain stays stable across restarts (free-tier static domain).
- `e.habibi@anan.sa` is the Directus project owner / Administrator.
- AI gateway default URL is `:8081` in configs, but the **running hybrid PM2 ai-gateway is on :8085** — verify the topology before trusting a port.
- Directus data persists in Docker named volumes (`postgres_data`, `redis_data`, `directus_uploads`); container recreates are safe.

---

## 5. Known technical debt (from the frontend audit + session)

- **Cross-portal duplication (largest):** `AuthContext.tsx`, `ProtectedRoute.tsx`, `Login.tsx`, `LanguageToggle`, `AppCommandPalette`, `AppKeyboardShortcuts`, `directus.ts`, `RouteError`, `App.tsx` shells are ~90% duplicated between admin- and agent-portal. No shared "portal-shell" package → fixes must be applied twice.
- **Directus response type coercions:** repeated `as unknown as {...}` for the conversation `vendor` field (`ConversationSidebar.tsx`, `ConversationToolbar.tsx`) and ticket attachment mapping (`tickets/api.ts`). Shared types don't reflect these shapes.
- **Windows build workarounds:** chat-widget uses esbuild JSX instead of `@preact/preset-vite` (Windows ESM bug — do NOT revert); all three apps keep a separate `vitest.config.ts` to avoid importing `vite.config.ts` (esbuild config-bundling crash).
- **No build-time secret guard:** nothing fails the build if a `VITE_*` var (esp. `VITE_WIDGET_JWT_SECRET`, `VITE_JOB_PRODUCER_TOKEN`) holds a real secret and gets baked into the client bundle.
- **No admin domain API:** portals do Directus CRUD directly from the browser; authorization rests entirely on Directus collection permissions (no server-side business-rule/audit layer beyond Directus' own log).
- **Dev machine is RAM-tight:** parallel `tsc`/`vitest` can OOM. Use single-worker test runs + a Node heap flag (`NODE_OPTIONS=--max-old-space-size=4096`), run typechecks per-package sequentially.

---

## 6. Known bugs

- **(FIXED this session) Widget host-page CTA collapsed onto one line** — `.chat-card-title`/`.chat-card-sub` were inline spans; needed `display:block`. Fixed + committed by a parallel actor (`066721a`).
- **(ROOT-CAUSED + FIXED) Recurring "Your account does not have administrator access" at :8092** — stale Directus container missing cookie/CORS env → session refresh failed after the 15-min access token. Fixed by recreating Directus. Residual: the user's browser may still hold a legacy cached bundle → needs **one** hard reload (Ctrl+Shift+R / Clear site data) to drop it.
- **No client-side diagnostic for a failed cross-origin auth refresh** — when the cookie/CORS config is wrong, the failure is silent (degraded auth), not a clear error. (Latent; not yet addressed.)

No other open functional bugs were found; the frontend audit found **no** TODO/FIXME/HACK markers, dead buttons, placeholder pages, or stubbed prod paths.

---

## 7. Known deployment issues / not-yet-done for go-live

Deploy branch is `001`. Code is green; the gaps are operational (tracked in `crm-app/docs/GO-LIVE-READINESS.md`):

- Rotate every secret (`DIRECTUS_ADMIN_PASSWORD` dev=`123456`, `DIRECTUS_KEY`/`SECRET`, `SVC_*`, `YIJI_JWT_SECRET` ≥32 chars, DB creds).
- `NODE_ENV=production`; `CORS_ORIGIN` = exact hostnames (prod guard rejects `*`); `SMTP_*` set (workers refuse to boot without `SMTP_HOST`); `GEMINI_API_KEY`.
- TLS/WSS + CSP/HSTS at the edge; managed Postgres + Redis on private nets + backup/restore drill.
- DNS for the 5 subdomains; GHCR images via `deploy.yml` (local Docker build is RAM-bound).
- Staging verification: `pnpm test:e2e`, load test, bootstrap idempotence (`deploy-preflight`), smoke (`/ready`, widget connects, realtime, SLA timer).
- **PR #33** (infra compose `app` profile) is **open** and should be merged so the deploy branch carries the footgun fix. **PR #30** (portal SPA no-cache → `001`) is **merged** (`8bd73ba`).
- A **production `.env` draft** was generated to the session scratchpad (`…/scratchpad/env.prod.cutover-draft`) with freshly-generated `[GENERATE]` secrets + `CHANGE_ME` placeholders. **It is ephemeral (lost when the session is deleted) and the secrets should be regenerated on the prod host anyway** (`scripts/gen-prod-secrets.sh`). Do not rely on it persisting.

---

## 8. Workarounds currently in use

- **Widget JSX via esbuild** (not `@preact/preset-vite`) — Windows ESM resolver bug. Trade-off: no widget HMR (full reload on edit). Keep.
- **Separate `vitest.config.ts` per app** to avoid importing `vite.config.ts` on Windows.
- **`no-cache` nginx headers** on the SPA shell to defeat stale-bundle caching (now in Dockerfiles + edge config; live container patched).
- **ngrok** fronting the widget dev server on :5175 (static domain in `chat-widget/.env.local`).
- **`docker compose up -d directus`** (name the service) for infra-only, OR the new `start-infra.ps1` / `stop-infra.ps1` helpers — never bare `up -d` from `crm-app-infra` until PR #33 merges.
- **Single-worker test runs + heap flag** to avoid OOM on this box.

---

## 9. Environment setup knowledge

- **Shell:** PowerShell is required for `pnpm`/`docker`/`pm2` (Node is NOT on PATH inside Git-Bash pnpm-lifecycle subshells — `'node' is not recognized`). Bash tool works for plain git/grep.
- **Ports:** dev 5173 (agent), 5174 (admin), 5175 (widget); served 8090 (agent), 8092 (admin); Docker infra: postgres **5433**, redis **6380**, directus **8055**; PM2: gateway **8080**(+**8081** http), ai-gateway **8085**, workers (no port).
- **Logins:** admin `e.habibi@anan.sa` / `123456`; agent `e2e.agent@example.com` / `E2eAgentPass1!`.
- **Bring the stack up (hybrid):** infra → `cd crm-app-infra && docker compose up -d directus` (pulls postgres+redis); apps → `cd crm-app && pm2 start ecosystem.config.cjs` (reads `crm-app/.env.prod`, `pm2 save`); portals served by the `yiji-portals` nginx container; widget → `cd crm-app-frontend/apps/chat-widget && pnpm dev` (PowerShell), then ngrok.
- **Do NOT stop the :5175 widget dev server** — it kills the user's ngrok tunnel (this happened twice this session; see §13).
- **PM2 persistence:** `pm2 save` done; after reboot use `pm2 resurrect` (or configure `pm2 startup`).
- **Verification commands used:** `docker compose config --services` (profile check), Playwright headless login repro against :8092, socket.io handshake through the tunnel (`/socket.io/?EIO=4&transport=polling`), `Invoke-WebRequest` header checks for `Cache-Control`/`Access-Control-Allow-Credentials`.

---

## 10. Branching and repository knowledge

- **One remote, four checkouts** (see §0).
- **Branches observed:** `main` (crm-app), `stream/frontend` / `stream/infra` / `stream/quality`, `001-yiji-crm-platform` (deploy/release; PRs converge here), plus feature branches (`deploy/linux-build-frontend`, the `fix/*` branches I created).
- **Commits/PRs created or touched this session:**
  - `crm-app`: `e8c1c56` (portal Dockerfile no-cache), `9559a87` (edge nginx no-cache) — both reached `main`.
  - `crm-app-frontend`: `7c46921` (portal Dockerfile no-cache) on `stream/frontend` (pushed).
  - `crm-app-infra`: `93c1358` (compose `app` profile + docs + start/stop-infra.ps1) on `fix/infra-compose-app-profile` → **PR #33 (open)**.
  - **PR #30** (`deploy/cache-headers-to-001`) → **MERGED** as `8bd73ba` (cache fixes on the deploy branch).
  - Verified but not authored by me: `734f902` (PR #27 convergence merge), `066721a` (widget a11y), `409e50b` (retire deploy docs), PRs #31/#32.
- **Convergence merge `734f902`** integrated 001 (security C-1/C-2/H-2 + deploy arch) into `stream/frontend`; I verified it (typecheck 4 pkgs clean; socket-gateway 117 + admin 83 + agent 143 tests pass; compose + Dockerfiles valid; no conflict markers).
- **Commit hooks:** husky + lint-staged run prettier/eslint on commit (reformatted some files; harmless). Commits co-authored with the Claude trailer.

---

## 11. Features currently unfinished

- **Deployment** is the main unfinished work (operational, not UI) — see §7.
- **PR #33** (infra compose profile) awaits merge into `001`.
- No unfinished UI features: the audit found every page wired to real data; the only "disabled" surface (AI features per-vendor toggle in `AiConfigPage`, with `AiPanel` showing "Disabled by admin.") is intentional and complete.

---

## 12. Recommendations for future work

1. **Extract a shared `portal-shell` package** to kill the admin/agent duplication (AuthContext, ProtectedRoute, Login, shells).
2. **Add an admin domain API** (or formally audit/lock Directus collection permissions + audit-log retention) so the browser isn't the only authorization layer.
3. **Build-time guards:** fail the build if any `VITE_*` looks like a secret, and if a production widget build would bake a real JWT secret / the demo mint.
4. **Tighten Directus response types** to remove `as unknown as` coercions (esp. conversation `vendor`, ticket attachments).
5. **Add a client-side diagnostic** for failed cross-origin auth refresh (so the silent cookie/CORS misconfig surfaces clearly).
6. **Merge PR #33**; then verify a bare `docker compose up -d` is infra-only everywhere.
7. Consider an `infra`-only compose (or keep the profile) as the documented hybrid path; update any remaining docs that say bare `up` = full stack.

---

## 13. Mistakes that should NOT be repeated

1. **Do not stop the :5175 widget dev server.** I stopped it during cleanup twice → the user's ngrok tunnel broke ("ngrok not working"). Leave it running (background task); ngrok depends on it.
2. **Do not run a bare `docker compose up -d` from `crm-app-infra`.** It starts Docker app services that collide with the PM2 app tier (8080 bind failure; duplicate `workers` double-consume the BullMQ queue → duplicate jobs/emails). Use `docker compose up -d directus` or the `app` profile / `start-infra.ps1`.
3. **Do not overwrite `crm-app/.env.prod`.** It is the local prod-rehearsal env reusing the live Directus tokens; overwriting breaks local auth. (The Write tool's read-before-write guard caught this — heed it.)
4. **Do not assume "branch moved" = mystery/conflict.** It's a sibling-checkout push on the shared remote; fetch and check.
5. **Do not stop at the first plausible root cause.** The admin-access issue looked like browser cache; the real recurrence was a stale Directus container. Re-diagnose on recurrence with a fresh-browser repro to separate client state from server state.
6. **Editing a gitignored or soon-to-be-retired file is wasted work** — verify a file is tracked and current (`git ls-files`, check the "final architecture") before investing in edits (the DEPLOY-HYBRID.md edit was discarded).

---

## 14. Things another engineer would NOT discover by reading the code

- The four working dirs are the same repo (git remotes reveal it, but the _implication_ — "main moves because a sibling checkout pushed" — is non-obvious and caused real confusion).
- :8090/:8092 are served from **`crm-app`'s** dist via the `yiji-portals` nginx container, not from `crm-app-frontend`.
- `crm-app/.env.prod` is a _rehearsal_ env (not production) and must not be regenerated/overwritten.
- The recurring admin-auth failure was **container/compose drift**, not code — the code and data were always correct.
- Cookie-mode H-2 auth silently breaks on local http unless Directus has `CORS_CREDENTIALS=true` + non-Secure/SameSite=Lax refresh cookie.
- The ngrok static domain is fixed and pre-wired in `chat-widget/.env.local`; the widget's socket path goes ngrok → vite proxy → gateway.
- The AI gateway runs on **:8085** in the hybrid PM2 setup despite `:8081` defaults in configs.
- The widget design fixes were committed by a parallel actor (`066721a`), not in this dir's working tree.
- A production `.env` with freshly-generated secrets sits in the (ephemeral) session scratchpad.

---

## 15. Context that would be permanently lost if this session disappeared

- **The full diagnostic chain** for the recurring "no admin access": data correct → frontend code correct → served bundle current + `no-cache` set → fresh browser works → therefore browser cache → recurrence → **stale Directus container missing cookie/CORS env** → recreate → cold-load restore verified (refresh 200). Future-me would otherwise re-walk this from scratch (partially mitigated by the `directus-cookie-auth-stale-container.md` memory).
- **The exact safe vs unsafe Docker commands** for this hybrid box (see §8/§13) and _why_ bare `up` is a footgun (PR #33 fixes it but until merged the working tree still has the trap).
- **The ngrok ↔ dev-server ↔ gateway wiring** and that stopping :5175 kills the tunnel.
- **The branch/PR ledger** (§10) — which fix is on which branch and whether it reached the deploy branch `001` (PR #30 merged; cache fix on Dockerfiles + edge; PR #33 pending).
- **Generated production secrets** in the scratchpad (ephemeral; regenerate on prod).
- **The frontend audit** is preserved at `documentation/frontend-audit.md`; this export complements it with the operational/deployment narrative the audit deliberately excluded.
- **Live verification evidence** captured this session (header values, socket handshakes, test counts) that confirms current correctness but is not reproducible from code alone.

---

_End of export. Companion artifacts: `documentation/frontend-audit.md` (architecture audit), and the persistent memory files referenced in §0._
