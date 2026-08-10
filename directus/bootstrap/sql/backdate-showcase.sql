-- Backdate showcase demo rows so the dashboard reads a real 90-day history.
--
-- WHY THIS EXISTS: Directus manages `date_created` itself — the API ignores any
-- value you send for it. The showcase seeder therefore backdates only the fields
-- it CAN set (last_message_at, first_response_due_at, first_responded_at,
-- resolved_at...), which leaves every row stamped "created today".
--
-- That produces two visibly wrong things on the dashboard:
--   * average first response = first_responded_at - date_created, which comes out
--     hugely NEGATIVE (a response 90 days "before" creation);
--   * the conversation-volume chart piles every row onto today, so a 90-day trend
--     renders as one bar.
--
-- LOCAL DEMO DATABASE ONLY. Never run against production: it rewrites audit
-- timestamps, which is exactly what you never want on real records.
--
--   docker exec -i crm-app-infra-postgres-1 psql -U directus -d yiji_crm \
--     < directus/bootstrap/sql/backdate-showcase.sql

BEGIN;

-- Tickets: the seeder set first_response_due_at = opened + 30 min, so the
-- original open time is recoverable exactly.
UPDATE tickets
SET date_created = first_response_due_at - interval '30 minutes',
    date_updated = COALESCE(closed_at, resolved_at, first_responded_at)
WHERE first_response_due_at IS NOT NULL;

-- Conversations: last_message_at already carries the intended timeline.
UPDATE conversations
SET date_created = last_message_at
WHERE last_message_at IS NOT NULL;

-- Messages: spread across their conversation's lifetime rather than all landing
-- on its opening instant, so a thread reads like a conversation instead of a
-- burst. Deterministic offset from the row's own id keeps re-runs stable.
UPDATE messages m
SET date_created = c.date_created
                 + (('x' || substr(md5(m.id::text), 1, 8))::bit(32)::bigint % 240) * interval '1 minute'
FROM conversations c
WHERE m.conversation = c.id
  AND c.date_created IS NOT NULL;

-- CSAT: submitted_at is already correct; align date_created so any "responses
-- over time" view agrees with it.
UPDATE csat_responses
SET date_created = submitted_at
WHERE submitted_at IS NOT NULL;

COMMIT;

-- Verification: avg first-response must now be POSITIVE and plausible.
SELECT round(avg(EXTRACT(EPOCH FROM (first_responded_at - date_created)) / 60)::numeric, 1)
         AS avg_first_response_min,
       min(date_created)::date AS earliest,
       max(date_created)::date AS latest,
       count(*)                AS tickets
FROM tickets
WHERE first_responded_at IS NOT NULL;
