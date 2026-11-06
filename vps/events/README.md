# Catalogue outbox — ARCH-MOD-01-03, first increment

`1026_modular_outbox.sql` adds a private schema and a catalogue trigger. A change
and its event commit or roll back together. Events contain a canonical UUID and
a version, without source payloads, account IDs or user preferences. Timestamp
refreshes alone do not enqueue index work.

The existing worker runs a bounded projector loop independently of its minute
schedule. Claims use `SKIP LOCKED`, a 30-second lease and a fresh token. The
projection receipt and acknowledgement commit together. Older events cannot
replace a newer dirty version. Failed work retries at most five times; final
failures remain inspectable. Completed jobs expire after seven days in batches
of at most 1,000. API/session roles cannot access the schema or job controls.

`catalog_dirty` is a durable inbox for a future index writer. This increment
does **not** install Meilisearch or serve searches from an index. Reindexing,
engine-task acknowledgements, reconciliation, dead-job replay, metrics and
notifications/billing consumers remain separate work. A parent change must
eventually reproject affected descendants; an entity deletion must remove the
index document. No backfill is hidden in the migration.

Validation:

- `node --test vps/universal/*.test.mjs vps/events/*.test.mjs`
- CI: `node vps/events/ci.mjs` uses a disposable PostgreSQL 17 database.
- `pg-integration.mjs` refuses a database without the `svitlo_modular_qa_` prefix.
  It tests two concurrent workers and loss of an uncommitted claim connection.

Rollback: return to the previous application image; additive tables/trigger
remain compatible and preserve pending events. Do not drop the schema or
modify an applied migration to roll back. Inspect pending/dead work before a
later rollout. This queue is currently dedicated to catalogue projection and
does not replace existing sensor, delivery or discovery queues.
