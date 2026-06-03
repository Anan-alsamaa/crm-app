# Contract: socket-gateway realtime events

Socket.IO server (Fastify-hosted) with Redis adapter for horizontal scaling. Two namespaces by auth source; rooms route messages.

## Connection & auth

| Client | Handshake auth | Validation |
|---|---|---|
| Customer (widget) | `auth.token` = Yiji-signed JWT | signature (HS256 shared secret; RS256-ready), `exp`, vendor active, identity sanity. On success: upsert contact (dedup), attach vendor, resume/create open conversation. |
| Agent (portal) | `auth.token` = Directus access token | validated against Directus `/users/me`. Joins personal room + permitted conversation rooms. |

Invalid/expired/tampered token → connection refused, no records created (edge cases). Query params are never trusted.

## Rooms
- `conversation:{id}` — both parties + assigned agents.
- `agent:{userId}` — personal room (assignment broadcasts + in-app notification push).
- `vendor:{vendorId}` — presence.

## Events

### Client → Server
| Event | Payload | Sender | Effect |
|---|---|---|---|
| `message:send` | `{ conversationId, content, attachments?[], clientMsgId }` | customer/agent | Persist via Directus (gateway = sole writer), broadcast `message:new` to room, bump `last_message_at`/unread, enqueue side-effect jobs. |
| `note:add` | `{ conversationId, content, mentions?[], clientMsgId }` | agent | Persist `is_internal_note=true`; broadcast to agents only; enqueue mention notifications. |
| `typing:start` / `typing:stop` | `{ conversationId }` | both | Broadcast `typing:update` to room (no persistence). |
| `read:ack` | `{ conversationId, lastMessageId }` | both | Update `read_by`; reset agent unread. |
| `csat:submit` | `{ conversationId, score, comment? }` | customer | Persist one csat_response (unique per conversation). |

### Server → Client
| Event | Payload | Audience |
|---|---|---|
| `message:new` | `{ id, conversationId, senderType, content, attachments[], createdAt, clientMsgId }` | conversation room |
| `note:new` | internal note shape | agents in room |
| `typing:update` | `{ conversationId, who, isTyping }` | conversation room |
| `agent:assigned` | `{ conversationId, agentId, teamId }` | agent room + conversation room |
| `conversation:status_changed` | `{ conversationId, status }` | conversation room |
| `presence:update` | `{ vendorId, online[] }` | vendor room |
| `notification:pushed` | notification shape | target agent room |
| `error` | `{ code, message }` | offending client |

## Guarantees
- `clientMsgId` enables idempotent send + dedup on reconnect (no lost/dup messages).
- Reconnect with exponential backoff (client); server re-joins rooms from token + membership.
- Delivery target < 500 ms p95; cross-instance routing via Redis adapter (SC-002, SC-010).
