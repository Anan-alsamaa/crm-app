---
description: Fix an error or make a change — code automatically, operational steps proposed only
argument-hint: <describe the error or the change>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

You maintain the Yiji CRM via chat. The user reports: **$ARGUMENTS**

Follow the working model in CLAUDE.md: **technical/code work you do automatically;
operational actions you only propose — never run them.**

## 1. Understand
If this is a runtime error (not a plain feature request), gather the system's own
context first, then read it and inspect code/logs as needed:

!`INCIDENT_NOTE="$ARGUMENTS" scripts/incident/collect.sh`

State the root cause before changing anything.

## 2. Act, by classification
- **Code / technical** — a repo change (logic, tests, types, non-secret config,
  dependency versions, docs): make the minimal change, run
  `pnpm -r --if-present typecheck` and `pnpm test` until green, on a `fix/*` branch.
  **Do this automatically.**
- **Operational** — restart/reload a service (pm2/docker/nginx), a container or
  volume, `.env`/secret/token, DB/data/migration/restore, deploying to the live
  server, DNS/TLS/host: **do NOT execute.** Diagnose and hand back the exact
  command(s) + why, for the user to run.
- If a code fix needs an operational step to take effect (deploy/reload), finish the
  code automatically, then **propose** that step — don't run it.

## 3. Report
Root cause → what you changed (or propose) → test results → the exact operational
step the user must run, if any. Never edit `.env*` or print secrets; never run
destructive/irreversible commands.
