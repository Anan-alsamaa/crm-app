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
];
