# Pre-release audits

This document is the runbook for the four audits the Phase 10 polish work
tracks: accessibility (T116), performance (T117), horizontal scaling (T118),
and the end-to-end quickstart smoke test (T122). Each section names the
target, the procedure, the pass criteria, and how to file findings.

These audits are pre-release gates — they should pass before promoting
`main` to a production deploy.

## T116 — Accessibility (WCAG-aligned)

**Targets**: agent portal, admin portal, chat widget.

**Procedure (~30 min):**

```bash
# 1. Start the stack
pnpm --filter @yiji/agent-portal dev   # :5173
pnpm --filter @yiji/admin-portal dev   # :5174
pnpm --filter @yiji/chat-widget dev    # :5175

# 2. Run axe-core against every primary route. From a browser console:
#    window.axe = await import('https://unpkg.com/axe-core@4').then(m => m.default);
#    const r = await axe.run(); console.table(r.violations);
# 3. Tab through every screen with the keyboard only — make sure:
#    - focus is always visible (focus-visible ring fires)
#    - every interactive element is reachable
#    - the conversation thread's composer + send is keyboard-operable
#    - the drawer + dialog traps focus and returns it on close
# 4. Toggle the language to ar and confirm RTL flow at every screen
# 5. macOS VoiceOver (or NVDA on Windows) smoke pass on:
#    - login form (label associations)
#    - inbox list (list semantics + row labels)
#    - conversation thread (message origin announced)
#    - toolbar primary actions
```

**Pass criteria:**

- Zero `serious` or `critical` axe violations on every screen.
- All interactive elements reachable by Tab; focus order matches reading order.
- All drawers / modals trap focus and restore on close.
- All `aria-label`s read meaningfully (no `undefined` / placeholder text).
- RTL layout: no visual breakage; no LTR-only icons inverted incorrectly.

**Filing findings:** open a Linear issue per violation, label `a11y`.

## T117 — Performance

**Targets**: widget bundle size, agent portal load time, realtime latency.

**Procedure:**

### Widget bundle size

```bash
pnpm --filter @yiji/chat-widget build
ls -la apps/chat-widget/dist/yiji-chat-widget.js
gzip -9 -c apps/chat-widget/dist/yiji-chat-widget.js | wc -c
```

**Pass:** gzipped size < 50 KB (spec SC-011).

### Agent portal initial load

```bash
pnpm --filter @yiji/agent-portal build
pnpm --filter @yiji/agent-portal preview     # :4173
# In Chrome DevTools → Lighthouse → Performance (mobile profile)
# OR:
npx lighthouse http://localhost:4173 --only-categories=performance --quiet
```

**Pass:** Performance ≥ 85, FCP < 1.5 s, LCP < 2 s (spec SC-002).

### Realtime message latency

```bash
# Start: directus + redis + socket-gateway + agent portal + widget demo
# Open the widget demo + the agent inbox side-by-side; throttle to "Fast 3G"
# in DevTools. Send 20 messages from the widget. In the gateway logs
# (pino), measure timestamp delta between message:send arrival and the
# corresponding message:new broadcast.
```

**Pass:** p95 delta < 500 ms.

## T118 — Horizontal scaling

**Target:** verify that two socket-gateway instances share state correctly
through the Redis adapter and that two workers instances split jobs.

**Procedure:**

```bash
# Bring up Redis + Directus + Postgres
docker compose up -d postgres redis directus

# Run two gateway instances on different ports
PORT=8080 pnpm --filter @yiji/socket-gateway dev &
PORT=8082 pnpm --filter @yiji/socket-gateway dev &

# Run two workers instances
HEALTH_PORT=8090 pnpm --filter @yiji/workers dev &
HEALTH_PORT=8091 pnpm --filter @yiji/workers dev &

# Have the agent portal connect to :8080 (via VITE_SOCKET_URL) and the
# widget demo to :8082. Send a message from each side and confirm both
# arrive on the other instance — proves the Redis adapter is routing.

# Trigger 50 notification jobs (e.g. close 50 tickets in the agent portal
# with a notification rule). Watch each workers process's pino log —
# job ids should split roughly 50/50.
```

**Pass:**

- Messages cross-route between gateway instances < 200 ms post-send.
- Workers split jobs without duplicate processing.
- Killing one instance of either service does not break the other.

## T122 — Quickstart smoke test

Runs the README's quickstart end-to-end against a clean checkout. This
should pass without ANY undocumented steps.

**Procedure:**

```bash
# Fresh checkout
git clone <repo> /tmp/yiji-smoke && cd /tmp/yiji-smoke

# Follow README "Quick start — local SQLite" verbatim:
pnpm install
cd directus/local
cp ../../.env.example .env
# Edit .env: set DIRECTUS_ADMIN_EMAIL + DIRECTUS_ADMIN_PASSWORD + DIRECTUS_KEY + DIRECTUS_SECRET
npm install
npm run bootstrap
npm run start &
cd ../..

# Start each frontend in its own terminal
pnpm --filter @yiji/agent-portal dev
pnpm --filter @yiji/admin-portal dev
pnpm --filter @yiji/chat-widget dev

# Single-instance gateway (no Redis)
REDIS_ENABLED=false YIJI_JWT_SECRET=dev-yiji-secret \
  SVC_GATEWAY_TOKEN=$(grep ^SVC_GATEWAY_TOKEN .env | cut -d= -f2) \
  PORT=8080 pnpm --filter @yiji/socket-gateway dev
```

Then in a browser:

1. <http://localhost:5174/login> → sign in with admin creds.
2. Admin → Users → create a second user, assign them a team.
3. Admin → SLA → create a policy.
4. Admin → Vendors → create `demo-vendor` with `yiji_vendor_id=demo-vendor`.
5. <http://localhost:5175> → demo widget opens, says "connected".
6. Send a message from the widget.
7. <http://localhost:5173> → sign in as the agent → message appears in inbox.
8. Reply from agent → appears in widget in real time.
9. Convert conversation to ticket → ticket appears in agent's Tickets page.
10. Wait for SLA warning interval → confirm notification fires.

**Pass:** every step succeeds without an error in any service log and without
any undocumented manual fix.

## Tracking results

Record audit results in `docs/audit-results/<YYYY-MM-DD>.md` so we have a
versioned history of pass/fail per release. Each file should include:

- Date + commit SHA
- Pass/fail per audit
- Tools/versions used (axe, Lighthouse, Node)
- Open findings (link to issues)
