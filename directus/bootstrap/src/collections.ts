/**
 * Declarative Directus schema for Yiji CRM (data-model.md).
 * Consumed by apply.ts to create collections, fields, relations, and junctions
 * idempotently. This file is the version-controlled source of truth alongside
 * the generated snapshot in directus/snapshot/.
 */

import {
  COUPON_APPROVAL_STATUSES,
  CommunicationMethod,
  Compensation,
  ComplaintSource,
  ComplaintType,
  ConversationStatus,
  ServiceType,
  TicketStatus,
} from '@yiji/shared-types';

export type FieldType =
  | 'string'
  | 'text'
  | 'uuid'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'json'
  | 'dateTime';

export interface FieldSpec {
  field: string;
  type: FieldType;
  /** enum choices (renders as dropdown; validated app-side via shared-types). */
  choices?: string[];
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  defaultValue?: string | number | boolean | null;
  note?: string;
}

export interface CollectionSpec {
  collection: string;
  /** Human note shown in Directus. */
  note?: string;
  /** Singleton? (none here) */
  fields: FieldSpec[];
}

/** Many-to-one relations: a uuid field on `collection` pointing at `related`. */
export interface RelationSpec {
  collection: string;
  field: string;
  related: string;
  /** on-delete behavior */
  onDelete?: 'SET NULL' | 'CASCADE' | 'NO ACTION';
  /** Index the FK column (only applied when the field is first created). */
  index?: boolean;
  /** Field note shown in Directus (only applied when the field is first created). */
  note?: string;
}

/** Many-to-many via a junction collection. */
export interface JunctionSpec {
  junction: string;
  collectionA: string; // owning
  fieldA: string; // junction field → A
  collectionB: string;
  fieldB: string; // junction field → B
  /**
   * Name of the M2M alias field to expose on collectionA (e.g. `conversations.tags`).
   * Without it the junction is only reachable directly; the owning collection
   * cannot read its related rows via a nested field. Set for every junction the
   * app reads as `A.<alias>`.
   */
  aliasA?: string;
}

const PRIORITY = ['low', 'medium', 'high', 'urgent'];

export const collections: CollectionSpec[] = [
  {
    collection: 'vendors',
    note: 'Vendors the CRM supports (data entities, not users). Each runs on a commerce PLATFORM reached through that platform’s connector. Only NON-SECRET integration settings live here: API credentials (admin email/password, API keys) stay in service configuration until MV-3 decides how secrets are encrypted at rest. Managed by the Administrator only.',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'logo', type: 'uuid', note: 'directus_files' },
      { field: 'colors', type: 'json' },
      { field: 'support_settings', type: 'json' },
      { field: 'yiji_vendor_id', type: 'string', required: true, unique: true },
      { field: 'status', type: 'string', choices: ['active', 'inactive'], defaultValue: 'active' },
      /*
       * INTEGRATION SETTINGS (MV-1, EMA-70). All nullable: the deployed code
       * reads none of them yet, so the schema can land before any release.
       */
      {
        field: 'platform',
        type: 'string',
        /* `mock` (MV-6): the staging TEST platform — simulated data, zero
           network calls, served only where ALLOW_MOCK_VENDORS=true. */
        choices: ['yiji', 'mock'],
        defaultValue: 'yiji',
        note: 'The commerce platform this vendor runs on — picks the connector. NULL reads as yiji (every vendor before MV-1). `mock` = staging test vendor (simulated data, never calls any platform; refused unless the service sets ALLOW_MOCK_VENDORS=true).',
      },
      {
        field: 'api_base_url',
        type: 'string',
        note: 'The platform’s order API base URL (Yiji: https://order.yiji-app.com). Not a secret.',
      },
      {
        field: 'admin_api_url',
        type: 'string',
        note: 'The platform’s admin API base URL (Yiji: https://admin.yiji-app.com). Not a secret.',
      },
      {
        field: 'tenant_id',
        type: 'string',
        note: 'The platform tenant (Yiji `tenantid` header). Empty = the service configuration value.',
      },
      {
        field: 'brand_id',
        type: 'string',
        note: 'Fallback brand for customer push when the customer has no order. Empty = the service configuration value.',
      },
      {
        field: 'notify_settings',
        type: 'json',
        note: 'Non-secret customer-push settings (notify URL, topic, title, open-chat action). The API key is a secret and is NOT stored here (MV-3).',
      },
      {
        field: 'webhook_path_key',
        type: 'string',
        unique: true,
        note: 'The <vendor> segment of this vendor’s future /webhooks/<vendor> URL. Unique; lowercase letters, digits and dashes.',
      },
    ],
  },
  {
    collection: 'teams',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
    ],
  },
  {
    collection: 'brands',
    note: 'Restaurant brands — operations master data, editable in the admin portal.',
    fields: [
      { field: 'code', type: 'string', required: true, unique: true, note: 'e.g. LCP' },
      { field: 'name', type: 'string', required: true, note: 'e.g. La Casa Pasta' },
      {
        field: 'yiji_brand_name',
        type: 'string',
        index: true,
        note: 'Exactly what the Yiji order API returns in brandName. Only needed when it differs from name. Matching trims it — Yiji ships values with a leading space.',
      },
      {
        field: 'status',
        type: 'string',
        choices: ['active', 'inactive'],
        defaultValue: 'active',
      },
    ],
  },
  {
    collection: 'stores',
    note: 'Restaurant branches — operations master data. Mapped onto Yiji orders so tickets can be reported by store, brand and city.',
    fields: [
      { field: 'code', type: 'string', index: true, note: 'e.g. LCP-002' },
      { field: 'name', type: 'string', required: true, index: true, note: 'e.g. Marina Mall 2' },
      { field: 'city', type: 'string', index: true },
      { field: 'area_manager', type: 'string' },
      { field: 'chain_manager', type: 'string' },
      {
        field: 'yiji_restaurant_id',
        type: 'string',
        index: true,
        note: "Yiji's own restaurant id. Optional: the ops sheets do not carry it today, and matching falls back to a normalised name compare. Set it and this store matches exactly, regardless of naming drift.",
      },
      {
        field: 'status',
        type: 'string',
        choices: ['active', 'inactive'],
        defaultValue: 'active',
      },
    ],
  },
  {
    collection: 'contacts',
    note: 'Customers of vendors; deduped per vendor by phone/email',
    fields: [
      {
        field: 'external_customer_id',
        type: 'string',
        note: 'The id YIJI issued for this customer. NULL when we do not know it — a walk-in visitor typed a phone number and their Yiji account, if any, cannot be looked up from it. Never write a value we minted ourselves; see isPhoneDerivedCustomerId.',
      },
      /**
       * How this customer first reached us.
       *
       * `walk_in` is somebody who scanned a QR code standing in a branch;
       * `app` came through the Yiji app with an identity already attached.
       * Kept because it is worth something later — a walk-in is a customer who
       * was physically in a shop, which is exactly what a personalised offer
       * wants to know, and it is the honest counterpart to a null
       * `external_customer_id`.
       *
       * Its own column rather than a key inside `metadata`: Directus cannot
       * filter inside a json column, so anything that lives only in a blob is
       * unsearchable — the same reason tickets.order_id is a column.
       */
      {
        field: 'acquisition_channel',
        type: 'string',
        /*
         * THREE STATES, because two conflated the wrong pair (owner,
         * 2026-09-13).
         *
         * This used to be `['app', 'walk_in']`, derived from a single boolean:
         * "did we get a Yiji id?". That put an app customer STANDING IN A
         * BRANCH into `app`, indistinguishable from one on their sofa — so the
         * question "how many of our app customers actually visit the shops?"
         * could not be asked at all.
         *
         * The fix is to stop making one field answer two questions. The door
         * they came through and whether they hold a Yiji account are
         * independent, and the doors that can occur are:
         *
         *   app          -> opened the chat inside the Yiji app
         *   walk_in_app  -> scanned the branch QR code AND has a Yiji account
         *   walk_in      -> scanned the branch QR code, no known account
         *   phone        -> an AGENT created them while raising a ticket
         *
         * `phone` is the one door a customer does not walk through themselves:
         * somebody rang, or complained at a counter, and an agent typed their
         * number into the Add-ticket page. Kept distinct because folding it
         * into `walk_in` would inflate the QR numbers with people who never
         * scanned anything (owner, 2026-09-16).
         *
         * (The combination "in the app without an account" cannot happen,
         * which is why the self-service doors are three and not four.)
         *
         * Existing rows stay valid: every earlier value keeps its meaning and
         * nothing needs migrating.
         */
        choices: ['app', 'walk_in_app', 'walk_in', 'phone'],
        index: true,
        note: 'How the customer first reached us. app = opened from the Yiji app. walk_in_app = scanned the branch QR code and has a Yiji account. walk_in = scanned the QR code with no known Yiji account. phone = created by an agent raising a ticket (phoned in, or at a counter).',
      },
      { field: 'name', type: 'string' },
      { field: 'phone', type: 'string', index: true },
      { field: 'email', type: 'string', index: true },
      { field: 'avatar', type: 'uuid', note: 'directus_files' },
      { field: 'metadata', type: 'json' },
    ],
  },
  {
    collection: 'conversations',
    fields: [
      {
        // Two states only — see ConversationStatus. Retired values are migrated
        // by scripts/migrate-conversation-status.mjs, not just dropped here:
        // bootstrap reconciles whether a field EXISTS, not what is stored in it.
        field: 'status',
        type: 'string',
        choices: [...ConversationStatus.options],
        defaultValue: 'open',
      },
      { field: 'priority', type: 'string', choices: PRIORITY, defaultValue: 'medium' },
      { field: 'last_message_at', type: 'dateTime', index: true },
      /**
       * When the chat was marked solved. Cleared when it is reopened.
       *
       * The status alone says WHETHER a chat is finished, never WHEN, so
       * "how long did this take" is unanswerable without it — and
       * `date_updated` is not a substitute: it moves on every unrelated edit,
       * so a tag added a week later would read as a week-long chat.
       * Indexed because agent performance filters on it by date range.
       */
      { field: 'solved_at', type: 'dateTime', index: true },
      /**
       * When this chat was put away, or null while it is still in the inbox.
       *
       * A flag rather than a move to a cold table. At the volumes this system
       * will see, the conversations themselves are small — the cost of an old
       * chat is that it sits in the working set the inbox scans, not the bytes
       * it occupies — so excluding it from that scan is the whole win, and it
       * is reversible by writing null. Moving rows between tables buys nothing
       * here and risks losing them; that trade only changes past tens of
       * millions of rows.
       *
       * Nothing sets this automatically. See scripts/archive-conversations.mjs.
       */
      { field: 'archived_at', type: 'dateTime', index: true },
      { field: 'unread_count_agent', type: 'integer', defaultValue: 0 },
      /**
       * THE CHAT FIRST-RESPONSE CLOCK.
       *
       * This is where first response actually belongs, and where it used to be
       * measured on the wrong object. A ticket carried `first_response_due_at`
       * and nothing in the product ever wrote the matching `first_responded_at`
       * — because the reply that answers a customer happens HERE, in the chat,
       * usually before anyone has decided a ticket is warranted. Every ticket
       * with that deadline therefore breached and stayed breached: six tickets,
       * one recorded reply, 20,381 stale breach events swept out when it was
       * found. The ticket's promise is now solving time alone; the promise to
       * answer lives on the conversation, next to the messages that satisfy it.
       *
       * `first_responded_at` is stamped by the gateway on the first non-internal
       * AGENT message — see socket-gateway/src/directus.ts. Indexed because the
       * agent-performance reports filter on it by date range.
       */
      { field: 'first_response_due_at', type: 'dateTime' },
      { field: 'first_responded_at', type: 'dateTime', index: true },
      /**
       * When the promise was recorded as missed — the breach LEDGER, not a
       * derived flag.
       *
       * Stored rather than recomputed because it is what makes the sweep
       * idempotent: the reconcile runs every few minutes, and without a written
       * record it would page the agent about the same unanswered chat on every
       * pass. It also keeps the breach honest after the fact — a chat answered
       * late still shows that it was late, which a `due_at < responded_at`
       * comparison would also give but only while both survive.
       */
      { field: 'first_response_breached_at', type: 'dateTime' },
      /**
       * The customer's newest order AT THE TIME THIS CHAT WAS WORKED, stamped
       * by the commerce proxy the first time the sidebar resolves it.
       *
       * Two jobs, and the second is why it is a column and not a cache:
       *
       *  1. The inbox can paint the order panel from its own data instantly,
       *     instead of waiting on two round trips to an external API.
       *  2. "Find the chat about order 946641" becomes answerable. Directus
       *     cannot filter inside a `json` column at all, so an id that lives
       *     only in a snapshot is unsearchable — same reasoning as
       *     tickets.order_id and stores.yiji_restaurant_id.
       *
       * Indexed: the inbox search box hits it on every keystroke.
       */
      { field: 'last_order_id', type: 'string', index: true },
      {
        /* THE ORDER THE CUSTOMER CAME FROM — set once, at creation, and never
         * by the portal.
         *
         * This was first folded into `last_order_id` on the reasoning that two
         * columns meaning "the order" would drift. That was wrong, and wrong in
         * a way only the running system showed: `last_order_id` has a SECOND
         * writer — the agent portal stamps whatever the order panel resolved —
         * so the tracked order was overwritten by the customer's newest one
         * minutes later, and every chat then claimed to be "about" whatever
         * order was last viewed.
         *
         * They are different facts. `last_order_id` is the order most recently
         * LOOKED AT, which is why the inbox searches it. This is the order the
         * customer OPENED THE CHAT FROM, which only Yiji knows and only at the
         * moment the session is minted (owner, 2026-09-27). */
        field: 'entry_order_id',
        type: 'string',
        index: true,
        note: "Yiji's order id when the chat was opened from that order's tracking screen. Written once at creation; never stamped by the portal.",
      },
      {
        field: 'last_order_snapshot',
        type: 'json',
        note: 'The order as it stood when this chat was worked. Rendered while the live copy revalidates, so the panel is never blank.',
      },
      {
        field: 'last_order_at',
        type: 'dateTime',
        note: 'When the snapshot was taken — NOT when the order was placed. Says how stale the painted panel may be.',
      },
      /*
       * WHY A PUSH FAILURE NEEDS A COLUMN AND NOT JUST A LOG LINE.
       *
       * Yiji refuses about a third of our notifications with "Customer has no
       * registered FCM device token" — a fact about the person, not a fault to
       * retry. The agent who just sent a message is the one who needs to know,
       * so they can nudge the customer another way instead of waiting for a
       * reply nothing ever prompted. CloudWatch cannot tell them that.
       */
      {
        field: 'push_unreachable_at',
        type: 'dateTime',
        note: 'When a push to this customer was permanently refused — they have no app notifications. CLEARED on a later success: installing the app makes them reachable again.',
      },
      {
        field: 'push_unreachable_reason',
        type: 'string',
        note: "Yiji's own words for the refusal, kept verbatim so a change in their wording is visible rather than silently reclassified.",
      },
      /*
       * A CHAT THE AGENT STARTED IS A DIFFERENT OBJECT.
       *
       * It has no customer first message, so anything that measures "how long
       * did the customer wait for an answer" must not count it. Recorded rather
       * than inferred: inferring it from "is the first message from an agent"
       * would also catch a chat whose customer message was deleted.
       */
      /*
       * ONE THREAD, MANY SESSIONS.
       *
       * A returning customer keeps their conversation — never a second one —
       * so the thread outlives the exchange that opened it. The first-response
       * PROMISE does not: somebody writing today is waiting today, and being
       * answered quickly last week says nothing about that.
       *
       * This is the clock's zero, stamped when a solved chat reopens.
       * `date_created` cannot do the job: for a chat reopened weeks later it
       * points at the original message, so the deadline is already past and
       * the chat breaches the instant the sweep sees it.
       */
      {
        field: 'session_started_at',
        type: 'dateTime',
        index: true,
        note: 'When the CURRENT session began. A reopened chat starts a new first-response clock from here, not from date_created — which belongs to the exchange that first opened the thread.',
      },
      {
        field: 'initiated_by',
        type: 'string',
        choices: ['customer', 'agent'],
        defaultValue: 'customer',
        note: 'Who opened this chat. An agent-initiated chat has no inbound first message, so the first-response promise does not apply to it.',
      },
    ],
  },
  {
    collection: 'walk_in_links',
    note: 'Personal chat links. A short CODE stands for a phone number, so the number never travels in a URL and the link can be revoked by deleting the row.',
    fields: [
      /**
       * The code that appears in the link, and the only part a customer sees.
       *
       * A SHORT OPAQUE CODE rather than a signed token in the query string.
       * The token version worked and was 200 characters of base64 — unusable in
       * print, in a WhatsApp message, or read aloud. More importantly a signed
       * token cannot be REVOKED: it is valid until it expires, whatever anyone
       * later wishes. A row can be deleted.
       *
       * Ten characters of Crockford base32 is 32^10 — about 1.1 quadrillion.
       * That matters because opening this link opens a chat AS that customer,
       * so a guessable code is the same enumeration hole a `?phone=` would have
       * been. Crockford omits I, L, O and U, so nothing is misread off a card
       * or misheard on a call.
       */
      { field: 'code', type: 'string', index: true, required: true },
      {
        field: 'phone',
        type: 'string',
        index: true,
        note: 'Canonical 05XXXXXXXX. The whole point: this stays server-side.',
      },
      { field: 'expires_at', type: 'dateTime', index: true },
      /**
       * When it was first opened. Not a limit — a customer may reopen their own
       * chat, and a link that dies on first use dies when a preview fetches it.
       * It is here so an operator can see whether the link ever landed.
       */
      { field: 'used_at', type: 'dateTime' },
      { field: 'revoked_at', type: 'dateTime', note: 'Set to kill a link early.' },
    ],
  },
  {
    collection: 'messages',
    fields: [
      { field: 'sender_type', type: 'string', choices: ['customer', 'agent', 'system'] },
      { field: 'content', type: 'text' },
      { field: 'is_internal_note', type: 'boolean', defaultValue: false },
      { field: 'read_by', type: 'json' },
      /**
       * Agents may correct or withdraw their own reply for 15 minutes (owner,
       * 2026-10-05 (EMA-33)). Only the socket gateway writes these — the Agent
       * role still holds no update on messages.
       */
      { field: 'edited_at', type: 'dateTime', note: 'Last edit by the sending agent.' },
      {
        field: 'deleted_at',
        type: 'dateTime',
        note: 'Soft delete by the sending agent; content is blanked.',
      },
      /**
       * The wording before the FIRST edit or delete, kept for audit. Set once
       * and never overwritten, so a second edit cannot launder the first.
       * Never selected by a customer-facing read.
       */
      {
        field: 'original_content',
        type: 'text',
        note: 'Pre-edit/pre-delete wording, set once (audit).',
      },
      /**
       * WHERE THE WORDS CAME FROM (owner, 2026-10-07): recorded so the canned
       * and AI-written replies agents actually send — and the situations they
       * send them in — can be studied before any of it is automated. Set by
       * the socket gateway only; the portal reports what it inserted, the
       * gateway decides.
       */
      {
        field: 'source',
        type: 'string',
        index: true,
        choices: [
          'customer',
          'typed',
          'quick_reply',
          'ai_suggestion',
          'ai_enhance',
          'auto_welcome',
          'internal_note',
          'system',
        ],
        note: 'Origin of the text: typed by the agent, a quick reply, an AI suggestion/enhancement, the automatic welcome, etc.',
      },
      {
        field: 'quick_reply_id',
        type: 'string',
        index: true,
        note: 'The quick reply used, when source = quick_reply. A plain id, not a relation, so deleting the reply never touches the history.',
      },
      {
        field: 'source_text',
        type: 'text',
        note: 'The text as inserted (quick reply / AI), before the agent edited it. Compare with content to see what agents change.',
      },
      {
        field: 'source_edited',
        type: 'boolean',
        note: 'True when the agent changed the inserted text before sending.',
      },
    ],
  },
  {
    collection: 'tickets',
    fields: [
      { field: 'subject', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'status',
        type: 'string',
        /*
         * TWO states (owner, 2026-10-07): `pending` and `solved` — see
         * TicketStatus. The retired spellings stay in the CHOICE LIST, after
         * the live two, because stored rows are not migrated (~7,900 imported
         * tickets hold `closed`) and a choice list that dropped them would show
         * those rows as invalid in the Directus admin. The portals never offer
         * them: every reader goes through `normaliseTicketStatus`.
         *
         * The default only reaches a NEW environment — `createField` is
         * idempotent and never re-applies schema on an existing one — so the
         * portals send `status: 'pending'` explicitly on every insert rather
         * than trusting it; an existing database keeping `new` as its default
         * still normalises to pending.
         */
        choices: [...TicketStatus.options, 'open', 'new', 'resolved', 'closed'],
        defaultValue: 'pending',
      },
      { field: 'priority', type: 'string', choices: PRIORITY, defaultValue: 'medium' },
      { field: 'first_response_due_at', type: 'dateTime' },
      { field: 'resolution_due_at', type: 'dateTime' },
      { field: 'first_responded_at', type: 'dateTime' },
      { field: 'resolved_at', type: 'dateTime' },
      { field: 'closed_at', type: 'dateTime' },
      // Point-in-time snapshot of the Yiji order the ticket was raised about,
      // captured when the ticket is created from a chat. Structured JSON (not
      // prose in `description`) so the UI can render it as a real order card
      // and so it stays queryable. The order may change or vanish upstream,
      // which is exactly why this is a snapshot rather than a live lookup.
      { field: 'order_snapshot', type: 'json' },
      /**
       * The order id, lifted OUT of the snapshot into a column of its own.
       *
       * Not redundant: Directus cannot filter inside a `json` column at all. A
       * nested path is rejected as a field-permission error and `_contains` is
       * refused outright ("json field type does not contain the _contains
       * filter"), so "find the chat about order 1095975" is unanswerable while
       * the id lives only in the snapshot. Indexed, because that lookup runs
       * from the inbox search box on every keystroke.
       *
       * The snapshot stays the record of what the order WAS; this is the key
       * you search on. Same reasoning as stores.yiji_restaurant_id.
       */
      { field: 'order_id', type: 'string', index: true },
      /**
       * The customer's number, typed on the ticket itself.
       *
       * A ticket normally reaches its customer through `contact`, and that
       * stays the better link — it carries their history, their other tickets
       * and their orders. But a walk-in complaint has no such row: somebody
       * phones in, or stands at a counter after a Takeout or Dine-in order,
       * and they are simply not in the CRM. The contact picker searches our
       * own `contacts`, found nothing, so there was nothing to select and the
       * form stayed disabled — the agent could not raise the ticket at all
       * (owner, 2026-09-15).
       *
       * A column rather than prose in `description`, for the same reason
       * `order_id` is one: "find the ticket for 0501234567" has to be
       * answerable, and free text is not reliably searchable. Indexed, because
       * that lookup happens while a customer is waiting.
       *
       * NOT a replacement for `contact`: every reader prefers the contact and
       * falls back to this only when there is none.
       */
      { field: 'customer_phone', type: 'string', index: true },
      // The store's ATTRIBUTION (branch, brand, city, area/chain manager) as it
      // stood when the ticket was raised. Resolving it live at report time
      // would let one edit rewrite history: move a branch to a new area
      // manager and last quarter's complaints silently become theirs. Frozen
      // here for the same reason `order_snapshot` is — see StoreSnapshot in
      // @yiji/shared-types.
      { field: 'store_snapshot', type: 'json' },

      /* Complaint classification — the operations team's own complaint columns,
       * so a ticket raised in the portal reports alongside the complaints they
       * log by hand today. Choices come from @yiji/shared-types so this schema
       * and the portal's dropdowns cannot drift apart; the odd spellings there
       * are deliberate (see the note on ComplaintType).
       *
       * Every one is nullable: existing tickets have none of them, and the
       * inbox still raises ordinary support tickets that are not complaints. */
      {
        field: 'complaint_date',
        type: 'dateTime',
        index: true,
        note: 'When the complaint HAPPENED, which is not when it was typed in. A complaint phoned in on Friday and logged on Sunday belongs to Friday in every ops report, and the historical import has dates far older than its rows. Null on tickets raised before this field existed; the reports fall back to date_created, so an old ticket still lands on a sensible day.',
      },
      {
        field: 'complaint_type',
        type: 'string',
        choices: [...ComplaintType.options],
        index: true,
        note: 'What the customer complained about. Indexed — every ops report groups by it.',
      },
      {
        field: 'service_type',
        type: 'string',
        choices: [...ServiceType.options],
        note: 'How the order was fulfilled (Delivery, Pickup, …). Pre-filled from the order snapshot when the order says.',
      },
      {
        field: 'complaint_source',
        type: 'string',
        choices: [...ComplaintSource.options],
        note: 'Channel the complaint ARRIVED on.',
      },
      {
        field: 'communication_method',
        type: 'string',
        choices: [...CommunicationMethod.options],
        note: 'Channel the agent ANSWERED on. Deliberately separate from complaint_source — a Twitter complaint is routinely answered on WhatsApp, and both are reported.',
      },
      {
        field: 'response_desc',
        type: 'text',
        note: 'What was done about it, in the agent’s words (their "Response Desc" column).',
      },
      {
        field: 'compensation',
        type: 'string',
        choices: [...Compensation.options],
        note: 'Whether the customer was compensated. "Initial" = not decided yet.',
      },
      { field: 'coupon_code', type: 'string', note: 'Coupon issued to the customer, if any.' },
      {
        field: 'coupon_value',
        type: 'float',
        note: 'Coupon face value in SAR. Their dashboard sums this as total compensation, so it must be a number — never a formatted string.',
      },
      { field: 'coupon_percent', type: 'float', note: 'Coupon discount as a percentage (0–100).' },
    ],
  },
  {
    collection: 'option_lists',
    note: 'Editable dropdown values (complaint type, service type, source, communication method, compensation). The operations team maintains these themselves — adding a complaint type must never require a code deploy.',
    fields: [
      {
        field: 'list',
        type: 'string',
        required: true,
        index: true,
        note: 'Which dropdown this value belongs to, e.g. complaint_type.',
      },
      { field: 'value', type: 'string', required: true },
      { field: 'sort', type: 'integer', defaultValue: 0 },
      {
        field: 'active',
        type: 'boolean',
        defaultValue: true,
        note: 'Deactivated rather than deleted: an old ticket keeps displaying a value that has since been retired.',
      },
    ],
  },
  {
    collection: 'app_roles',
    note: 'Declarative app roles. A row here is the SOURCE OF TRUTH; the app-roles-sync Directus extension materializes it into a real Directus role + policy + permissions. Editing permissions by hand in Directus for these roles is futile — the next sync replaces them.',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'privileges',
        type: 'json',
        note: 'Map of privilege key -> boolean, from the fixed catalog in the app-roles-sync extension. Unknown keys are ignored, never invented into permissions.',
      },
      {
        field: 'brands',
        type: 'json',
        note: 'Array of brand ids this role may see. Empty/null = all brands. Baked into the materialized ticket/store permissions as literal filters.',
      },
      {
        field: 'stores',
        type: 'json',
        note: 'Array of branch (store) ids this role may see. Empty/null = every branch its brands allow. INTERSECTS with `brands` rather than competing with it, so an area manager fenced to a brand and three of its branches sees those three. Baked into the materialized permissions as literal filters.',
      },
      {
        field: 'directus_role',
        type: 'string',
        note: 'Written back by the extension once materialized. Read-only in spirit.',
      },
      { field: 'directus_policy', type: 'string' },
      {
        field: 'builtin',
        type: 'boolean',
        defaultValue: false,
        note: 'True for the display-only rows mirroring the code-defined roles (Admin, Agent). The extension refuses to touch these.',
      },
    ],
  },
  {
    collection: 'app_settings',
    note: 'Small key/value settings the operations team may edit (e.g. the WhatsApp message template). One row per key.',
    fields: [
      { field: 'key', type: 'string', required: true, index: true },
      { field: 'value', type: 'text' },
    ],
  },
  {
    collection: 'quick_replies',
    note: 'Ready-made replies offered above the composer. Modelled on the operations portal’s own canned-reply row, which agents already work from: the point is that the common answer is one click rather than one paragraph retyped forty times a day, and typed the same way every time.',
    fields: [
      {
        field: 'label',
        type: 'string',
        required: true,
        note: 'What the chip says. Short — it has to read at a glance in a scrolling row.',
      },
      {
        field: 'text',
        type: 'text',
        required: true,
        note: 'The reply itself. Supports {order}, {name}, {brand} and {restaurant}, filled from the conversation at click time.',
      },
      {
        field: 'lang',
        type: 'string',
        choices: ['en', 'ar'],
        defaultValue: 'en',
        note: 'Used to rank: replies in the language the CUSTOMER is writing come first.',
      },
      {
        field: 'kind',
        type: 'string',
        choices: ['chat', 'late_order_reason', 'late_order_action'],
        defaultValue: 'chat',
        note: 'WHICH LIBRARY this row belongs to. `chat` is the inbox composer; `late_order_reason` and `late_order_action` are the two boxes on a late-order decision. They are deliberately SEPARATE sets (ops, 2026-10-04): a reason explains why an order was late, an action says what was done about it, and neither is a reply to a customer — one shared list would offer an agent mostly wrong answers in all three places. Rows written before this existed have no value and read as `chat`, which is where they came from.',
      },
      { field: 'sort', type: 'integer', defaultValue: 0 },
      { field: 'active', type: 'boolean', defaultValue: true },
    ],
  },
  {
    collection: 'coupon_approvals',
    note: 'A coupon an agent wants to give a customer, waiting on a supervisor. The coupon does NOT reach the ticket until it is approved — that is the whole point, so approval cannot be a rubber stamp applied after the money is already promised. Rejected rows are kept: a rejection is a decision somebody made and has to stay answerable for.',
    fields: [
      { field: 'coupon_code', type: 'string' },
      { field: 'coupon_value', type: 'float', note: 'Face value in SAR.' },
      { field: 'coupon_percent', type: 'float', note: 'Discount as a percentage (0–100).' },
      {
        field: 'compensation',
        type: 'string',
        choices: [...Compensation.options],
        note: 'What the agent intends to record on the ticket once this is approved.',
      },
      { field: 'reason', type: 'text', note: 'Why the agent is asking. Read by the supervisor.' },
      {
        /*
         * THE ORDER, HELD DIRECTLY — so a coupon does not need a ticket.
         *
         * Delivery to Yiji needs an order id and nothing else; it used to read
         * one only through `ticket.order_id`, which quietly made a ticket a
         * precondition for compensating anybody. A late order is compensated
         * straight from the queue with no complaint behind it, so the id is
         * carried here and the ticket stays optional (owner, 2026-09-21).
         *
         * The ticket's own order still wins when there is one — see
         * `couponOrderId`. This is a fallback, not a second source of truth.
         */
        field: 'order_id',
        type: 'string',
        index: true,
        note: 'The Yiji order this coupon is attached to, when it was raised without a ticket.',
      },
      {
        /*
         * Generated from the shared vocabulary, never retyped. The column used
         * to list three states while the worker wrote a fourth (`assigned`, the
         * moment Yiji accepts a coupon) and treated a fifth (`edited`) as
         * approved — so the value that means "the customer actually has this"
         * was not among the ones the console offered.
         */
        field: 'status',
        type: 'string',
        choices: [...COUPON_APPROVAL_STATUSES],
        defaultValue: 'pending',
        index: true,
      },
      { field: 'decided_at', type: 'dateTime' },
      {
        field: 'decision_note',
        type: 'text',
        note: 'The supervisor’s reason, required on a rejection — an agent told only "no" cannot answer the customer.',
      },
      /* THE RECEIPT FROM YIJI.
       *
       * `CreateCouponUserFromOrder` answers with
       * `extendedProperties.CouponUserId` — the id of the coupon Yiji actually
       * attached to the customer's order. Without it, "assigned" is a claim
       * this system makes about another system with nothing to check it
       * against: no way to answer "did the customer really get it?", and no
       * way to find the row on Yiji's side when they say they did not.
       *
       * Also the idempotency evidence. A retry after a timeout that in fact
       * succeeded would grant a second coupon; a stored id means the push can
       * see it already went. */
      {
        field: 'yiji_coupon_user_id',
        type: 'string',
        note: 'CouponUserId returned by Yiji when the coupon was attached to the order. Present only once delivery succeeded.',
      },
      {
        field: 'yiji_pushed_at',
        type: 'dateTime',
        note: 'When delivery was last ATTEMPTED. Paired with yiji_coupon_user_id on success, with yiji_push_error on failure.',
      },
      /**
       * Why the coupon has not reached Yiji, in words a supervisor can act on.
       *
       * Their API refuses with an HTTP 400 carrying a reason
       * ("User already have this coupon"), and retrying a settled answer only
       * buries it. Without somewhere to put that reason, an undelivered coupon
       * is indistinguishable on screen from one nobody has got to yet — which
       * is precisely the silent-empty shape this codebase keeps finding.
       *
       * Cleared the moment a delivery succeeds.
       */
      /**
       * Never send this one to Yiji, whatever else is true of it.
       *
       * Two real reasons, and both are permanent decisions rather than
       * failures: a coupon that was only ever a TEST (approved while the
       * integration was being built, against real customers who were never
       * meant to receive anything), and a coupon the branch has already
       * honoured in person so sending it would compensate twice.
       *
       * Distinct from `yiji_push_error`, which means "we tried and Yiji said
       * no" and can be cleared to try again. This one means "do not try", and
       * the delivery sweep skips it for good.
       */
      {
        field: 'delivery_excluded',
        type: 'boolean',
        defaultValue: false,
        note: 'Never send this coupon to Yiji — a test row, or already honoured another way. Not a failure; see yiji_push_error for those.',
      },
      {
        field: 'delivery_excluded_reason',
        type: 'string',
        note: 'Why it is excluded, so the decision is answerable later.',
      },
      /*
       * THE WITHHELD COUPON'S ID ON YIJI (owner, 2026-10-06).
       *
       * A withheld coupon is created on Yiji — Private, assigned to nobody — so
       * their portal accounts for every coupon the CRM issued. `AddCoupon`
       * answers with a COUPON id, which lands here.
       *
       * Its own column, NOT `yiji_coupon_user_id`: that one means "a customer
       * holds this coupon", and borrowing it for an unassigned coupon is what
       * confused the two states before. Also the idempotency evidence: set
       * means the worker never creates it again.
       *
       * Needs a manual `apply:fields` on staging and prod BEFORE the deploy
       * that reads it — a missing field 403s the whole Directus query.
       */
      {
        field: 'yiji_coupon_id',
        type: 'string',
        note: 'Yiji coupon id of a WITHHELD coupon, created on Yiji unassigned (Private, no assignee). Never a customer grant — see yiji_coupon_user_id for those.',
      },
      /*
       * WAITING FOR THE CUSTOMER TO JOIN YIJI (owner, 2026-10-07, EMA-49).
       *
       * A coupon for a number with no Yiji account is HELD here instead of
       * being created as an unassigned code: the delivery sweep re-checks the
       * number on a tapering schedule and delivers the moment it resolves.
       * Both need a manual `apply:fields` before the release that reads them.
       */
      {
        field: 'awaiting_signup_at',
        type: 'dateTime',
        note: 'Since when this coupon is held because the customer has no Yiji account yet. Kept after delivery as history.',
      },
      {
        field: 'signup_checked_at',
        type: 'dateTime',
        note: 'When the customer’s number was last looked up on Yiji while the coupon waited for them to sign up.',
      },
      {
        field: 'yiji_push_error',
        type: 'text',
        note: 'Why the last delivery attempt failed. Null once the coupon has been delivered.',
      },
    ],
  },
  {
    collection: 'store_notify_rules',
    note: 'Which complaint types are the BRANCH’s business. A ticket notifies its store only when its complaint_type has an enabled row here. Data, not a constant, because operations change the list without a deploy — and an empty table means "not set up yet", which notifies nobody rather than everybody.',
    fields: [
      {
        field: 'complaint_type',
        type: 'string',
        choices: [...ComplaintType.options],
        required: true,
        index: true,
      },
      { field: 'enabled', type: 'boolean', defaultValue: true },
    ],
  },
  {
    collection: 'store_notifications',
    note: 'OUTBOX of branch notifications. A row is the decision that this ticket should reach this branch, taken at save time with the rules as they stood; sending it is a separate concern and waits on the POS integration. Deliberately holds only the description and the resolution notes — a branch needs to know what went wrong and what was promised on their behalf, not the customer’s details or the coupon.',
    fields: [
      { field: 'complaint_type', type: 'string', index: true },
      { field: 'description', type: 'text' },
      { field: 'resolution_notes', type: 'text' },
      /**
       * WHICH order. A branch told "an item was missing" with no order number
       * cannot look anything up — they would have to ask us back, which is the
       * round trip this notification exists to remove.
       */
      { field: 'order_id', type: 'string', index: true },
      {
        field: 'order_items',
        type: 'json',
        note: 'What was ordered, as it stood on the ticket. The branch needs the line items to check a missing-item or wrong-item complaint against what they packed.',
      },
      {
        field: 'status',
        type: 'string',
        choices: ['queued', 'sent', 'failed'],
        defaultValue: 'queued',
        index: true,
      },
      { field: 'sent_at', type: 'dateTime' },
      { field: 'error', type: 'text', note: 'Why the last send attempt failed.' },
    ],
  },
  {
    collection: 'ticket_events',
    note: 'APPEND-ONLY audit history (no update/delete in any role)',
    fields: [
      {
        field: 'event_type',
        type: 'string',
        choices: [
          'created',
          'status_changed',
          'assigned',
          'commented',
          'sla_warning',
          'sla_breached',
          'sla_escalated',
          'resolved',
          'contacted',
          'closed',
          'reopened',
          'automation_triggered',
        ],
        required: true,
      },
      { field: 'payload', type: 'json' },
    ],
  },
  {
    collection: 'ai_calls',
    note: 'APPEND-ONLY log of every AI model call (owner, 2026-10-07): feature, model, tokens, estimated cost at list price, latency, outcome. Written by the AI gateway only.',
    fields: [
      { field: 'endpoint', type: 'string', required: true, index: true },
      { field: 'provider', type: 'string' },
      { field: 'model', type: 'string', index: true },
      { field: 'status', type: 'string', choices: ['ok', 'error'], required: true },
      { field: 'error_code', type: 'string' },
      { field: 'input_tokens', type: 'integer' },
      { field: 'output_tokens', type: 'integer' },
      { field: 'thinking_tokens', type: 'integer', note: 'Billed as output by Gemini 2.5.' },
      {
        field: 'est_cost_usd',
        type: 'float',
        note: 'At the PAID list price, even on a free tier — what this call would cost.',
      },
      { field: 'latency_ms', type: 'integer' },
      { field: 'user_id', type: 'string', index: true, note: 'The agent who asked.' },
      { field: 'vendor_id', type: 'string' },
      {
        field: 'conversation_id',
        type: 'string',
        index: true,
        note: 'Plain id, not a relation: deleting a chat must not erase its cost history.',
      },
    ],
  },
  {
    collection: 'routing_events',
    note: 'APPEND-ONLY record of auto-assignment outcomes (who was offered a conversation, and whether they answered)',
    fields: [
      {
        field: 'outcome',
        type: 'string',
        choices: ['answered', 'missed'],
        required: true,
      },
      {
        field: 'stage',
        type: 'string',
        choices: ['assign', 'escalate', 'broadcast'],
        required: true,
      },
      /* Seconds the agent had the conversation before this outcome was decided.
       * Stored rather than derived: the timer thresholds are configuration and
       * will change, and a historical row must keep the answer that was true
       * when it happened. */
      { field: 'seconds_held', type: 'integer' },
    ],
  },
  {
    collection: 'late_order_decisions',
    note: 'What an agent decided about a delivery order that ran past the late threshold. The DECISION is append-only; `reason` and `action_taken` may be edited afterwards via the Comments button, because wording gets corrected and a wrong note helps nobody. Written for BOTH outcomes: ignoring is a decision somebody has to stay answerable for, and a queue that forgets what it was told to ignore asks again tomorrow.',
    fields: [
      {
        /* The Yiji order id — the ONLY identifier the CRM and Yiji share for
         * one of these. Indexed because the queue reads this collection on
         * every poll to hide what has already been handled. */
        field: 'order_id',
        type: 'string',
        required: true,
        index: true,
      },
      {
        field: 'kind',
        type: 'string',
        choices: ['late_delivery', 'late_preparation'],
        required: true,
        note: 'Which leg ran long, as the agent classified it.',
      },
      {
        field: 'action',
        type: 'string',
        choices: ['ignored', 'compensated'],
        required: true,
      },
      {
        field: 'reason',
        type: 'text',
        required: true,
        note: 'Required for BOTH actions (owner, 2026-09-21) — an ignored order without a reason is an unanswerable decision.',
      },
      {
        /* WHAT THE AGENT DID about it, in their own words — "called the
         * branch", "issued a 20 SAR coupon", "driver reassigned".
         *
         * Separate from `action`, which is the decision TYPE (ignored /
         * compensated) and is a fixed vocabulary. The two were nearly merged;
         * they answer different questions, and a free-text value in `action`
         * would have broken every filter and report that groups by it
         * (owner, 2026-09-27).
         *
         * Optional: the reason is what makes a decision answerable, and
         * requiring a second paragraph before an agent may clear a row is how
         * a queue stops being worked. */
        field: 'action_taken',
        type: 'text',
        note: 'What the agent did about it, free text. Distinct from `action`, which is the decision type.',
      },
      {
        /* Stored, not derived: this is how late it was WHEN THE DECISION WAS
         * MADE. The order keeps running afterwards, so re-deriving it later
         * would rewrite the fact the agent actually acted on. */
        field: 'minutes_elapsed',
        type: 'integer',
        note: 'How far past the threshold the order was at the moment it was decided.',
      },
      /* Denormalised for the report, which must keep reporting the same brand
       * and branch however the upstream order or the store master later change. */
      { field: 'brand_name', type: 'string' },
      { field: 'restaurant_name', type: 'string' },
    ],
  },
  {
    collection: 'notifications',
    fields: [
      {
        field: 'type',
        type: 'string',
        choices: [
          'sla_warning',
          'sla_breach',
          'assignment',
          'mention',
          'ticket_update',
          'reminder',
          'escalation',
          'automation',
          'high_value_coupon',
          'access_change',
        ],
      },
      { field: 'title', type: 'string' },
      { field: 'body', type: 'text' },
      { field: 'link', type: 'string' },
      { field: 'read_at', type: 'dateTime' },
      { field: 'channel_inapp_delivered_at', type: 'dateTime' },
      { field: 'channel_email_delivered_at', type: 'dateTime' },
      { field: 'payload', type: 'json' },
    ],
  },
  {
    collection: 'sla_policies',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      { field: 'applies_to_priority', type: 'json' },
      /* WHICH tickets a policy governs, beyond their priority.
       *
       * Priority alone was the only thing a policy could narrow by, so every
       * policy anyone wrote was effectively just a pair of durations. But a
       * roach in the food and a missing sauce sachet are not the same promise,
       * and a complaint phoned in is not the same promise as one left on
       * Instagram overnight. Each of these is a list of the values it covers;
       * empty or null means the dimension is not tested. The matching rule
       * lives in one place for the worker and the console both — see
       * `pickSlaPolicy` in @yiji/shared-types.
       *
       * Stored as the same free strings the tickets store, NOT as enums: the
       * operations team edits `option_lists` without a deploy, and a policy
       * naming a type they later retire has to keep meaning what it said. */
      {
        field: 'applies_to_type',
        type: 'json',
        note: 'Complaint types this policy covers. Empty = any type.',
      },
      {
        field: 'applies_to_source',
        type: 'json',
        note: 'Arrival channels this policy covers. Empty = any channel.',
      },
      {
        field: 'applies_to_brand',
        type: 'json',
        note: 'Brand names this policy covers, matched against the ticket’s frozen store snapshot. Empty = any brand.',
      },
      /**
       * Which object this policy's clock runs on — see `SlaGoverns`.
       *
       * Defaults to `ticket` so every policy written before this field existed
       * keeps governing exactly what it governed. A chat policy reads
       * `first_response_minutes`; a ticket policy reads `resolution_minutes`.
       */
      { field: 'governs', type: 'string', choices: ['ticket', 'chat'], defaultValue: 'ticket' },
      { field: 'first_response_minutes', type: 'integer', required: true },
      { field: 'resolution_minutes', type: 'integer', required: true },
      { field: 'warning_threshold_percent', type: 'integer', defaultValue: 80 },
      /* WHEN the clock runs. Null = round the clock, which is what every
       * policy created through the console meant until the console could say
       * otherwise — a 4-hour resolution target counted through the night is a
       * breach recorded at 03:00 against a branch that was shut. Shape is
       * `{ timezone, days: { '0'..'6': [[open, close], ...] } }`; see
       * BusinessHours in services/workers/src/lib/sla-clock.ts, which has
       * computed against it correctly all along. */
      { field: 'business_hours', type: 'json' },
      { field: 'active', type: 'boolean', defaultValue: true },
    ],
  },
  {
    collection: 'automation_rules',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'trigger_event',
        type: 'string',
        choices: [
          'conversation_created',
          'message_received',
          'ticket_created',
          'ticket_status_changed',
          'sla_warning',
          'sla_breach',
          'inactivity',
          'keyword_matched',
        ],
      },
      { field: 'conditions', type: 'json' },
      { field: 'actions', type: 'json' },
      { field: 'active', type: 'boolean', defaultValue: true },
      { field: 'priority', type: 'integer', defaultValue: 0 },
      { field: 'last_triggered_at', type: 'dateTime' },
      { field: 'trigger_count', type: 'integer', defaultValue: 0 },
    ],
  },
  {
    collection: 'reports',
    fields: [
      { field: 'name', type: 'string', required: true },
      { field: 'description', type: 'text' },
      {
        field: 'type',
        type: 'string',
        choices: [
          'conversation_volume',
          'response_time',
          'sla_compliance',
          'ticket_resolution',
          'agent_productivity',
          'csat',
          'vendor_activity',
        ],
      },
      { field: 'filters', type: 'json' },
      { field: 'schedule', type: 'json' },
      { field: 'last_run_at', type: 'dateTime' },
    ],
  },
  {
    collection: 'tags',
    fields: [
      { field: 'name', type: 'string', required: true, unique: true },
      { field: 'color', type: 'string' },
      { field: 'description', type: 'text' },
    ],
  },
  {
    collection: 'custom_fields',
    fields: [
      { field: 'entity_type', type: 'string', choices: ['contact', 'conversation', 'ticket'] },
      { field: 'name', type: 'string', required: true },
      { field: 'key', type: 'string', required: true },
      {
        field: 'field_type',
        type: 'string',
        choices: ['text', 'number', 'boolean', 'date', 'select', 'multiselect'],
      },
      { field: 'options', type: 'json' },
      { field: 'required', type: 'boolean', defaultValue: false },
      { field: 'display_order', type: 'integer', defaultValue: 0 },
    ],
  },
  {
    collection: 'custom_field_values',
    fields: [
      { field: 'entity_type', type: 'string', choices: ['contact', 'conversation', 'ticket'] },
      { field: 'entity_id', type: 'uuid', required: true },
      { field: 'value', type: 'json' },
    ],
  },
  {
    collection: 'csat_responses',
    fields: [
      { field: 'score', type: 'integer', required: true },
      { field: 'comment', type: 'text' },
      { field: 'submitted_at', type: 'dateTime' },
    ],
  },
];

/*
 * THE VENDOR EVERY RECORD BELONGS TO (MV-1, EMA-70).
 *
 * A nullable `vendor` M2O (SET NULL, indexed) on each table below. The
 * deployed code neither writes nor filters on it, so the schema can land first
 * and nothing changes. Deleting a vendor must never take its coupons,
 * decisions or master data with it.
 *
 * Two meanings of NULL, and they are different:
 *  - RECORD and master-data tables: NULL = written before MV-1, i.e. the Yiji
 *    vendor, until `scripts/backfill-vendor.mjs` fills it in.
 *  - SHARED CONFIG: NULL = applies to EVERY vendor. The same agents serve all
 *    vendors, and most wording and SLA promises are not vendor-specific.
 *    Never backfilled.
 */

/** Tables whose NULL vendor means "legacy = Yiji" — the backfill targets. */
export const VENDOR_RECORD_COLLECTIONS = [
  'brands',
  'stores',
  'coupon_approvals',
  'late_order_decisions',
  'store_notify_rules',
  'store_notifications',
] as const;

/** Tables whose NULL vendor means "every vendor". Never backfilled. */
export const VENDOR_SHARED_CONFIG_COLLECTIONS = ['quick_replies', 'sla_policies'] as const;

function vendorScopedRelations(): RelationSpec[] {
  const rel = (collection: string, note: string): RelationSpec => ({
    collection,
    field: 'vendor',
    related: 'vendors',
    onDelete: 'SET NULL',
    index: true,
    note,
  });
  return [
    ...VENDOR_RECORD_COLLECTIONS.map((c) =>
      rel(
        c,
        'The vendor this belongs to. NULL = written before MV-1 (the Yiji vendor) until backfilled.',
      ),
    ),
    ...VENDOR_SHARED_CONFIG_COLLECTIONS.map((c) =>
      rel(c, 'The vendor this applies to. NULL = applies to EVERY vendor (shared config).'),
    ),
  ];
}

/** Many-to-one relations (foreign keys). */
export const relations: RelationSpec[] = [
  { collection: 'contacts', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  // SET NULL, not CASCADE: deleting a brand must never silently delete the
  // branches under it — those rows carry the city and manager mapping the
  // ticket reports depend on.
  { collection: 'stores', field: 'brand', related: 'brands', onDelete: 'SET NULL' },
  { collection: 'conversations', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  { collection: 'conversations', field: 'contact', related: 'contacts', onDelete: 'CASCADE' },
  {
    collection: 'conversations',
    field: 'assigned_agent',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  {
    collection: 'conversations',
    field: 'assigned_team',
    related: 'teams',
    onDelete: 'SET NULL',
  },
  {
    collection: 'conversations',
    field: 'csat_response',
    related: 'csat_responses',
    onDelete: 'SET NULL',
  },
  { collection: 'walk_in_links', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  {
    collection: 'walk_in_links',
    field: 'created_by',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  { collection: 'messages', field: 'conversation', related: 'conversations', onDelete: 'CASCADE' },
  {
    collection: 'messages',
    field: 'sender_user',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  { collection: 'messages', field: 'sender_contact', related: 'contacts', onDelete: 'SET NULL' },
  { collection: 'tickets', field: 'conversation', related: 'conversations', onDelete: 'SET NULL' },
  { collection: 'tickets', field: 'contact', related: 'contacts', onDelete: 'CASCADE' },
  { collection: 'tickets', field: 'vendor', related: 'vendors', onDelete: 'CASCADE' },
  {
    collection: 'tickets',
    field: 'assigned_agent',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  { collection: 'tickets', field: 'assigned_team', related: 'teams', onDelete: 'SET NULL' },
  { collection: 'tickets', field: 'sla_policy', related: 'sla_policies', onDelete: 'SET NULL' },
  /* The branch the complaint is about.
   *
   * The order snapshot already names a restaurant, but only for complaints that
   * arrived through a Yiji app order. Most do not — their own source list is
   * phone, WhatsApp, Instagram, X and WeCare — and a dine-in complaint has no
   * order at all. Without this column those tickets carry no branch, and every
   * report the operations team runs is grouped by branch, so they would be
   * invisible in exactly the reporting this feature exists to feed.
   *
   * SET NULL, not CASCADE: retiring a branch from the master list must never
   * delete the complaints logged against it. */
  { collection: 'tickets', field: 'store', related: 'stores', onDelete: 'SET NULL' },
  { collection: 'ticket_events', field: 'ticket', related: 'tickets', onDelete: 'CASCADE' },
  // The queue entry has no meaning without its ticket, and a branch that is
  // deleted has nobody left to tell.
  { collection: 'store_notifications', field: 'ticket', related: 'tickets', onDelete: 'CASCADE' },
  { collection: 'store_notifications', field: 'store', related: 'stores', onDelete: 'CASCADE' },
  { collection: 'coupon_approvals', field: 'ticket', related: 'tickets', onDelete: 'CASCADE' },
  { collection: 'coupon_approvals', field: 'contact', related: 'contacts', onDelete: 'SET NULL' },
  // Who asked and who decided. SET NULL rather than CASCADE: an agent leaving
  // must not erase the record of a coupon that was actually issued.
  {
    collection: 'coupon_approvals',
    field: 'requested_by',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  {
    collection: 'coupon_approvals',
    field: 'decided_by',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  {
    collection: 'routing_events',
    field: 'conversation',
    related: 'conversations',
    onDelete: 'CASCADE',
  },
  {
    collection: 'late_order_decisions',
    field: 'decided_by',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  {
    /* SET NULL, not CASCADE: deleting the ticket raised alongside must not
       erase the record that this order was handled, or the queue would offer
       it again as though nobody had ever looked at it. */
    collection: 'late_order_decisions',
    field: 'ticket',
    related: 'tickets',
    onDelete: 'SET NULL',
  },
  /* SET NULL, not CASCADE: a deleted agent must not erase the history of how
   * conversations were routed while they worked here. */
  {
    collection: 'routing_events',
    field: 'agent',
    related: 'directus_users',
    onDelete: 'SET NULL',
  },
  { collection: 'ticket_events', field: 'actor', related: 'directus_users', onDelete: 'SET NULL' },
  {
    collection: 'notifications',
    field: 'recipient',
    related: 'directus_users',
    onDelete: 'CASCADE',
  },
  { collection: 'reports', field: 'created_by', related: 'directus_users', onDelete: 'SET NULL' },
  {
    collection: 'custom_field_values',
    field: 'custom_field',
    related: 'custom_fields',
    onDelete: 'CASCADE',
  },
  {
    collection: 'csat_responses',
    field: 'conversation',
    related: 'conversations',
    onDelete: 'CASCADE',
  },
  { collection: 'csat_responses', field: 'contact', related: 'contacts', onDelete: 'CASCADE' },
  { collection: 'directus_users', field: 'team', related: 'teams', onDelete: 'SET NULL' },
  ...vendorScopedRelations(),
];

/** Many-to-many relations via junction collections. */
export const junctions: JunctionSpec[] = [
  {
    junction: 'contacts_tags',
    collectionA: 'contacts',
    fieldA: 'contacts_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
    aliasA: 'tags',
  },
  {
    junction: 'conversations_tags',
    collectionA: 'conversations',
    fieldA: 'conversations_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
    aliasA: 'tags',
  },
  {
    junction: 'tickets_tags',
    collectionA: 'tickets',
    fieldA: 'tickets_id',
    collectionB: 'tags',
    fieldB: 'tags_id',
    aliasA: 'tags',
  },
  {
    junction: 'messages_mentions',
    collectionA: 'messages',
    fieldA: 'messages_id',
    collectionB: 'directus_users',
    fieldB: 'directus_users_id',
    aliasA: 'mentions',
  },
  {
    junction: 'messages_files',
    collectionA: 'messages',
    fieldA: 'messages_id',
    collectionB: 'directus_files',
    fieldB: 'directus_files_id',
  },
  {
    junction: 'tickets_files',
    collectionA: 'tickets',
    fieldA: 'tickets_id',
    collectionB: 'directus_files',
    fieldB: 'directus_files_id',
    aliasA: 'attachments',
  },
];
