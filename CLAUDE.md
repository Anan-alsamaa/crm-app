<!-- SPECKIT START -->
Active feature: **Yiji CRM** (`001-yiji-crm-platform`).
Read the current plan and design artifacts before working:
- Plan: `specs/001-yiji-crm-platform/plan.md` (stack, structure, gates)
- Spec: `specs/001-yiji-crm-platform/spec.md`
- Research: `specs/001-yiji-crm-platform/research.md`
- Data model: `specs/001-yiji-crm-platform/data-model.md`
- Contracts: `specs/001-yiji-crm-platform/contracts/`
- Quickstart: `specs/001-yiji-crm-platform/quickstart.md`

Stack (non-negotiable): pnpm monorepo, TypeScript strict; Directus + Postgres + Redis;
Socket.IO (Redis adapter) gateway; BullMQ workers; AI gateway → Gemini (PII redacted,
swappable provider); React 18 + Vite portals + Preact widget; Tailwind, TanStack Query,
RHF + Zod, i18next (EN/AR RTL). Delivered in 6 phases.
<!-- SPECKIT END -->
