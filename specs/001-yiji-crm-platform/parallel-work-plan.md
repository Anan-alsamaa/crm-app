---
description: "Coordination plan for the post-spec 'completion' work across three parallel streams"
---

# Parallel Work Plan — Project Completion

Status (2026-06-04): all 123 tasks in [tasks.md](./tasks.md) are checked off.
The feature surface defined by the spec is implemented. This document
coordinates the **completion work** — everything required to move from
"feature-complete" to "shippable" — across three parallel streams that
share the `001-yiji-crm-platform` branch as their integration point.

## Goal

Take Yiji CRM from "works on my machine, all spec features land" to:
1. **Production-deployable** — real Dockerfiles, observability, secrets, deploy workflow.
2. **Polished** — mobile-responsive portals, complete loading/empty/error states, axe-clean.
3. **Trustworthy** — meaningful test coverage on every key path, lean CI, dev ergonomics.

## Streams

Three streams, each with **exclusive file ownership** so they don't merge-conflict
each other. The boundaries below are firm — if a task requires touching files
in another stream's territory, escalate (commit it to `001-yiji-crm-platform`
first, then resume your stream branch off the fresh tip).

| Stream | Worktree | Branch | Owns |
|--------|----------|--------|------|
| **A — Infra/Prod** | `../crm-app-infra` | `stream/infra` | `services/**`, `directus/**`, root `docker-compose*.yml`, `**/Dockerfile`, `.github/workflows/deploy*.yml`, `docs/PRODUCTION.md` |
| **B — Frontend/UX** | `../crm-app-frontend` | `stream/frontend` | `apps/**`, `packages/ui/**`, `packages/i18n/**` |
| **C — Quality/Docs/DX** | `../crm-app-quality` | `stream/quality` | `**/tests/**`, `.github/workflows/ci.yml`, root configs (`vitest.config.ts`, `playwright.config.ts`, `.eslintrc*`, `.prettierrc*`), `docs/**` except `PRODUCTION.md`, `README.md`, `.husky/**`, `package.json` scripts, `skills/**` |

### Shared territory — coordinate before touching

These can affect every stream; do not edit them inside a stream branch
without an explicit hand-off in `001-yiji-crm-platform` first:

- `packages/shared-types/**` — any new shared type lands on main, then streams pull.
- `packages/shared-config/**` — same rule.
- `pnpm-workspace.yaml`, root `tsconfig.base.json` — same rule.
- `pnpm-lock.yaml` — only one stream may add deps in a given push round.

## Stream A — Infra / Production Readiness

**Why:** spec is feature-done but there's no path from "works locally" to
"runs in production". This stream builds it.

Concrete tasks (rough order):
1. **Multi-stage Dockerfiles** for socket-gateway, workers, ai-gateway, agent-portal, admin-portal. Distroless or slim base. Build once, no dev deps in final layer.
2. **Production compose** (`docker-compose.prod.yml`) or `k8s/` manifests — pick one and commit to it.
3. **OpenTelemetry**: instrument all three Node services with `@opentelemetry/sdk-node`, OTLP HTTP exporter, configurable via env (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`). Auto-instrument HTTP, Redis, Postgres.
4. **Prometheus `/metrics`** on each service (request counts, latencies, queue depths for workers, socket counts for gateway).
5. **Postgres backup runbook**: `scripts/backup-pg.sh` + a one-shot restore script. Document in `docs/PRODUCTION.md`.
6. **Secrets**: document expected secret store (AWS Secrets Manager / Vault / k8s Secrets) and how each service reads them. No new code unless an adapter is needed.
7. **CORS + security headers** review per service. Make `CORS_ORIGIN` strict in prod; add CSP to the portals via their static-hosting layer (document where).
8. **Health checks**: every service's `/ready` does a real downstream check (DB ping, Redis ping, Directus reachability) rather than a process-is-alive check.
9. **Deploy workflow** (`.github/workflows/deploy.yml`): build images, push to a registry (placeholder: GHCR), tag releases. Manual `workflow_dispatch` trigger initially.
10. **Production env audit**: every required env var must be validated with Zod in `services/**/config.ts`; no defaults that would silently degrade in prod.
11. **Bootstrap idempotence verification**: run `pnpm --filter @yiji/directus-bootstrap apply` against a fresh Postgres, then again, confirm zero diff. Add a CI check that does this.
12. **`docs/PRODUCTION.md` update**: turn it from a sketch into a real runbook covering all of the above.

Done when: a fresh cloud VM (or k8s cluster) can stand the stack up from
images + env, observability shows up in the configured collector, backup
script runs cleanly, and the deploy workflow ships a tagged release.

## Stream B — Frontend / UX

**Why:** portals were built feature-first; polish (mobile, loading states,
empty states, error handling, accessibility, translations) is incomplete.
The chat widget is solid; portals are not.

Concrete tasks (rough order):
1. **Mobile responsive agent portal**: side rail → drawer at sm breakpoint, inbox list collapses, conversation view becomes single-column. Test on iPhone 14 viewport.
2. **Mobile responsive admin portal**: same treatment.
3. **Loading states**: every page that fetches data should render a skeleton (not a blank or spinner). Use `packages/ui` for shared skeleton primitives.
4. **Empty states**: every list view (inbox, tickets, contacts, vendors, automation, custom fields, …) needs a designed empty state with a call-to-action.
5. **Error boundaries**: route-level error boundary with retry on each major page.
6. **Toast notifications** unified across portals (some flows already toast; some don't).
7. **Accessibility audit**: run axe in CI (Playwright already imports it — extend the existing accessibility spec to cover every route). Fix every violation.
8. **Lighthouse**: agent-portal first-load < 2s on a throttled 4G profile, < 200KB initial JS (gzipped). Measure with `pnpm exec lighthouse` and bring it under budget.
9. **i18n completeness**: every string goes through `t()`, EN and AR keys exist for everything, RTL works on every page. Use `pnpm format:check` style automation to detect hardcoded JSX text.
10. **Polish recent presence/notes work**: the new sidebar internal-notes panel and the customer-page status pill could use a designer pass — type scale, spacing, icon weight.
11. **Keyboard nav**: command palette already partially exists; ensure every common action has a keyboard shortcut, and document them in a `?` overlay.
12. **Visual regression**: agree with Stream C on a Playwright screenshot approach for the half-dozen most-visible pages.

Done when: both portals look and feel polished on desktop and mobile,
axe reports zero serious/critical violations, Lighthouse meets the budget,
RTL+EN+AR audits pass cleanly, and the team would feel comfortable showing
this to a customer.

## Stream C — Quality / Docs / DX

**Why:** test coverage is sparse outside the gateway. CI's full-stack E2E
runs >20 min and is flaky. Pre-commit hooks don't exist (we re-ran prettier
manually after format drift). Docs cover the spec but not the actual
delivered shape.

Concrete tasks (rough order):
1. **Vitest coverage targets**: hit 70% line coverage in `services/**` and 60% in `apps/**`. Start by enumerating what's untested with `pnpm vitest --coverage`.
2. **Critical-path Vitest**:
   - `services/socket-gateway`: connection handler events end-to-end with mocked Directus.
   - `services/workers`: each queue processor's happy + failure paths.
   - `services/ai-gateway`: every endpoint × cache hit/miss × rate-limited/not.
   - `apps/agent-portal`: `features/inbox/api.ts`, mentions parser, custom-field section, AI panel.
   - `apps/admin-portal`: at least one render test per feature page.
3. **Critical-path Playwright**: agent login → assign → reply, admin create user → assign team, define custom field → renders, customer message → agent reply (the current spec exists but is gated behind `E2E_FULL_STACK=1`).
4. **CI optimization**: trim total runtime under 12 minutes. Cache `~/.cache/ms-playwright`. Cache pnpm via `actions/setup-node@v4` with `cache: pnpm`. Run quality job in parallel with E2E build phase.
5. **Husky + lint-staged**: pre-commit hook runs prettier + eslint on staged files only. Add `pnpm prepare` script for husky install.
6. **Coverage upload**: Codecov or just CI artifact + summary comment on PRs.
7. **Architecture doc** (`docs/ARCHITECTURE.md`): the current as-built shape — services, queues, sockets, Directus, the chat-widget embed contract. Should mention what's stateful vs stateless, what's required vs optional in prod.
8. **Agent user guide** (`docs/USER_GUIDE_AGENT.md`): how an agent uses the portal — sign in, work the inbox, write notes, use AI, change conversation state.
9. **Admin user guide** (`docs/USER_GUIDE_ADMIN.md`): user/team/SLA/automation/reports/branding/custom-fields configuration.
10. **README rewrite**: tight, accurate, links to all the above. Replace the spec-era language.
11. **Storybook (optional)** for `packages/ui`: only if time permits — useful but not required to ship.
12. **`.github/CODEOWNERS`**: assign reviewers per stream's territory once you know who owns what.

Done when: CI is green in <12 min on every push, coverage thresholds are
enforced (build fails on regression), pre-commit hooks prevent the format
drift class of bugs, and the three user-facing docs (agent guide, admin
guide, architecture) read cleanly.

## Coordination protocol

1. **Branches**: each stream commits to its own `stream/*` branch. Push freely; CI runs per push.
2. **Merging up**: when a stream completes a coherent chunk, open a PR into `001-yiji-crm-platform`. The integrator (the main worktree) reviews + merges.
3. **Conflicts**: file-ownership above means conflicts inside owned territory are impossible. Conflicts only happen in shared territory — see "Shared territory" above.
4. **Sync down**: after the integrator merges any stream's PR, each other stream rebases onto the new `001-yiji-crm-platform` tip:
   ```powershell
   git fetch origin
   git rebase origin/001-yiji-crm-platform
   ```
5. **Dependencies**: if Stream B needs a new shared type that Stream A also needs, the type lands on `001-yiji-crm-platform` first (via a tiny PR from whichever stream noticed), then both rebase.
6. **CI minutes**: every push runs the full CI workflow. Don't push speculative WIP — squash locally first or use draft commits.

## Out of scope for this round

- New end-user features that aren't in the spec.
- Migrations to a different framework / stack.
- Refactors that don't serve one of the three "done when" criteria above.

## Cleanup when this is finished

Once all three streams merge and the project is shipped:
```powershell
git worktree remove ../crm-app-infra
git worktree remove ../crm-app-frontend
git worktree remove ../crm-app-quality
git branch -d stream/infra stream/frontend stream/quality
```
