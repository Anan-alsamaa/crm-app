# Contracts — Yiji CRM

The platform exposes/consumes these contracts. Each is the source of truth for the corresponding `packages/shared-types` definitions so frontend apps and backend services cannot drift.

| Contract | File | Surface |
|---|---|---|
| Socket.IO realtime events | [socket-gateway.events.md](./socket-gateway.events.md) | Widget ↔ gateway ↔ portals |
| AI gateway HTTP API | [ai-gateway.openapi.yaml](./ai-gateway.openapi.yaml) | Agent portal / workers → ai-gateway |
| Yiji platform client | [yiji-client.interface.md](./yiji-client.interface.md) | Services/portals → Yiji platform (mock + real) |
| Directus collections & roles | [directus-collections.md](./directus-collections.md) | All CRUD + role permission matrix |
| BullMQ queues | [queues.md](./queues.md) | Gateway → workers job payloads |

**Note**: Directus auto-generates REST/GraphQL CRUD for every collection (see [data-model.md](../data-model.md)); those endpoints are not re-specified here. The role permission matrix and the custom service contracts are what need explicit definition.
