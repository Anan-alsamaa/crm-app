-- Reset the local demo to ONE clean scenario.
--
-- The showcase seeder filled the dashboard with 90 days of synthetic history so
-- the charts had shape. That is the right shape for a metrics demo and the WRONG
-- shape for a scenario walkthrough, where the point is a single customer whose
-- order data resolves against the real commerce API. Hundreds of fake pharmacy
-- tickets only make it harder to find the row that matters.
--
-- Keeps exactly: 1 vendor (Yiji), 1 admin, 1 agent, 1 customer (the one whose
-- external_customer_id maps to a real order), 1 conversation with its messages.
-- Everything the seeder invented is removed.
--
-- LOCAL DEMO DATABASE ONLY.
--
--   docker exec -i crm-app-infra-postgres-1 psql -U directus -d yiji_crm \
--     < directus/bootstrap/sql/demo-reset-minimal.sql

BEGIN;

-- The customer to keep: the one wired to a real order.
CREATE TEMP TABLE _keep_contact AS
SELECT id FROM contacts
WHERE external_customer_id = 'a3f7d293-d19e-4b21-95b1-c39542b65742'
LIMIT 1;

-- The single conversation to keep: that customer's most recent.
CREATE TEMP TABLE _keep_convo AS
SELECT id FROM conversations
WHERE contact = (SELECT id FROM _keep_contact)
ORDER BY COALESCE(last_message_at, date_created) DESC NULLS LAST
LIMIT 1;

-- Delete children first — FKs point inward at conversations.
DELETE FROM csat_responses    WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo);
DELETE FROM messages_files    WHERE messages_id IN (
  SELECT id FROM messages WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo));
DELETE FROM messages_mentions WHERE messages_id IN (
  SELECT id FROM messages WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo));
DELETE FROM messages          WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo);

DELETE FROM tickets_tags  WHERE tickets_id IN (
  SELECT id FROM tickets WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo));
DELETE FROM tickets_files WHERE tickets_id IN (
  SELECT id FROM tickets WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo));
DELETE FROM ticket_events WHERE ticket IN (
  SELECT id FROM tickets WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo));
DELETE FROM tickets       WHERE conversation IS DISTINCT FROM (SELECT id FROM _keep_convo);

DELETE FROM conversations_tags WHERE conversations_id IN (
  SELECT id FROM conversations WHERE id <> (SELECT id FROM _keep_convo));
DELETE FROM conversations      WHERE id <> (SELECT id FROM _keep_convo);

DELETE FROM contacts_tags WHERE contacts_id IN (
  SELECT id FROM contacts WHERE id <> (SELECT id FROM _keep_contact));
DELETE FROM contacts      WHERE id <> (SELECT id FROM _keep_contact);

DELETE FROM notifications;

-- Demo agents invented by the seeder. The real admin and the e2e agent survive;
-- service accounts are matched by their svc-* addresses and must NOT be removed,
-- or the gateway and workers lose the identity they authenticate as.
DELETE FROM directus_users
WHERE email IN ('mona.demo@example.com', 'ziad.demo@example.com', 'dina.demo@example.com');

COMMIT;

SELECT (SELECT count(*) FROM vendors)                                    AS vendors,
       (SELECT count(*) FROM contacts)                                   AS contacts,
       (SELECT count(*) FROM conversations)                              AS conversations,
       (SELECT count(*) FROM messages)                                   AS messages,
       (SELECT count(*) FROM tickets)                                    AS tickets,
       (SELECT count(*) FROM directus_users WHERE email NOT LIKE 'svc-%') AS people;
