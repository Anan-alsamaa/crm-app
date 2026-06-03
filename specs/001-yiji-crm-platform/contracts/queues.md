# Contract: BullMQ queues & job payloads

All on Redis 7. Producers: socket-gateway (chat side-effects), Directus flows/hooks (entity events), workers themselves (chained/scheduled). Consumers: `services/workers`. All jobs: retries with backoff + dead-letter on exhaustion; idempotent processors; graceful shutdown drains in-flight.

| Queue | Trigger / producer | Payload (shape) | Processor responsibility |
|---|---|---|---|
| `sla` | ticket created/updated/reopened (delayed jobs at warning + deadline) + periodic reconcile sweep | `{ ticketId, kind: 'warning'|'breach'|'reconcile', dueAt }` | Re-check ticket state at fire time; if unmet, write `ticket_events` (`sla_warning`/`sla_breached`), enqueue `notifications`, trigger escalation on breach. Respect business hours. |
| `notifications` | sla, automation, mentions, assignments, status changes, reminders | `{ recipientId, type, title, body, link, payload }` | Read recipient channel prefs (D-07); in-app → write `notifications` row + emit `notification:pushed` to `agent:{id}`; email → `MailTransport`; stamp delivery timestamps. |
| `ai` | conversation closed; scheduled lead scoring | `{ job: 'summarize'|'score_lead'|..., conversationId }` | Call ai-gateway endpoint(s) (PII redaction happens there); persist results where applicable. |
| `automation` | trigger events (conversation_created, message_received, ticket_*, sla_*, inactivity, keyword_matched) | `{ triggerEvent, entity, context, _depth }` | Load active matching rules, eval conditions, execute actions in `priority` order, write `automation_triggered` ticket_event, bump counters. `_depth` guard prevents loops (D-08). |
| `imports` | admin CSV upload | `{ fileId, vendorId, mapping }` | Stream CSV, upsert contacts with per-vendor dedup (SC-007), report row-level results. |
| `reports` | repeatable jobs from each `reports.schedule` cron | `{ reportId }` | Run Directus aggregation per filters, render CSV, email recipients via `MailTransport`, set `last_run_at`. |

## Cross-cutting
- **Idempotency**: side-effect jobs key on entity id + event so retries don't double-write (e.g., one `sla_breached` event per ticket per deadline).
- **Dead-letter**: exhausted jobs moved to `{queue}:dead` for inspection; alerting hook reserved for future.
- **Observability**: each processor logs (pino) start/finish/fail with job id + correlation id; `/health` + `/ready` on the workers service.
- **Mail/AI/storage** accessed only through their interfaces (`MailTransport`, `AIProvider`, Directus storage, `YijiClient`) so implementations are env-swappable.
