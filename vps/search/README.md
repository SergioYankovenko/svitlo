# Address search

PostgreSQL owns identities, aliases and electrical bindings. Meilisearch holds
only the public projection. An engine hit is hydrated and checked against the
current PostgreSQL projection before it is returned. House suffixes, corpora,
slashes, and Latin/Cyrillic characters are distinct. Exact lookups use a B-tree.

The worker builds a new generation without changing the active pointer. A
repeatable-read batch contains both documents and scope tokens. Engine tasks
must succeed before the durable checkpoint advances. Catalogue writes racing
with the checkpoint retain their work token. A standby generation continues
receiving changes. Activation requires a completed backfill and drained work.
An empty/lost/stale index falls back to the existing bounded catalogue search.
Signed cursors cannot cross a query, parent or generation.

Enable by mounting `/run/search/read-key` in API containers and
`/run/search/write-key` in the worker, with `MEILI_URL=http://search:7700`.
Neither key is sent to browsers. The reader key needs only `search` and
`documents.get`; the worker needs index/document/settings operations and
`tasks.get`. Both are restricted to `svitlo_catalog_g_*` and
`svitlo_dictionary_g_*`. No master key belongs in an application container.
Keys missing at startup disable the optional dependency.

The isolated real-service pilot (2026-11-07) indexed 25,600 public catalogue
rows in 55.2 s; 209 checks passed, including 200 exact house cases, a rebuild
under writes and dependency failure. Engine p95 was 13.38 ms, peak container
memory 214,482,944 bytes. These are engine measurements, not the full-API
20 requests/s, 60-minute acceptance gate. Existing Cherkasy provider-dictionary
requests still use their bounded cache path until its own projection is ready.

Run `node --test vps/search/*.test.mjs` locally. CI additionally runs the actual
PostgreSQL and pinned Meilisearch integration. Never use a live/private database
for this fixture; the runner only accepts an isolated QA database name.
