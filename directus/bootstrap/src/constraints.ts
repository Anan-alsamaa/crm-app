/**
 * Indexes and partial-unique constraints that Directus' schema API cannot
 * express directly (partial uniqueness WHERE NOT NULL). Applied as raw SQL via
 * a Postgres connection in apply.ts. Idempotent (IF NOT EXISTS).
 *
 * Implements the deduplication rule from data-model.md:
 *   - (vendor, phone) unique where phone is non-null
 *   - (vendor, email) unique where email is non-null
 */
export const constraintStatements: string[] = [
  // Per-vendor dedup (partial unique indexes).
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_vendor_phone
     ON contacts (vendor, phone) WHERE phone IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_vendor_email
     ON contacts (vendor, email) WHERE email IS NOT NULL;`,

  // Supporting lookup indexes.
  `CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone);`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email);`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
     ON conversations (last_message_at);`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation);`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events (ticket);`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications (recipient);`,

  // One CSAT response per conversation.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_csat_conversation
     ON csat_responses (conversation);`,

  // Custom field key unique per entity_type.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_fields_entity_key
     ON custom_fields (entity_type, key);`,

  // M2M junctions: a given pair may only be linked once. Without these the same
  // tag (or mention/file) can be attached to the same parent repeatedly, which
  // is what let a single conversation accumulate dozens of duplicate tag chips.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_tags
     ON conversations_tags (conversations_id, tags_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_tags
     ON contacts_tags (contacts_id, tags_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_tags
     ON tickets_tags (tickets_id, tags_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_mentions
     ON messages_mentions (messages_id, directus_users_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_files
     ON messages_files (messages_id, directus_files_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_files
     ON tickets_files (tickets_id, directus_files_id);`,

  // Hard cap: at most 5 tags per conversation. The unique index above stops
  // duplicate links; this stops a 6th distinct link. Enforced at the database
  // so it holds regardless of client (portal cap is just the friendly UX).
  `CREATE OR REPLACE FUNCTION enforce_max_conversation_tags() RETURNS trigger AS $$
     BEGIN
       IF (SELECT count(*) FROM conversations_tags
             WHERE conversations_id = NEW.conversations_id) >= 5 THEN
         RAISE EXCEPTION 'A conversation can have at most 5 tags'
           USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;
     END;
   $$ LANGUAGE plpgsql;`,
  `DROP TRIGGER IF EXISTS trg_max_conversation_tags ON conversations_tags;
   CREATE TRIGGER trg_max_conversation_tags
     BEFORE INSERT ON conversations_tags
     FOR EACH ROW EXECUTE FUNCTION enforce_max_conversation_tags();`,
];
