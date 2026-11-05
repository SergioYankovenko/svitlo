# GEO-01 / BE-01 r2 — settlement directory and provisional provider routes

This additive test-server API does not change saved profiles, catalogue UUIDs, the old address search, sensor access, schedules or subscriptions. PWA and Android must explicitly adopt the new endpoints in a separate change. It does not require Supabase Cloud, an external geocoder, or a paid search connector.

## Sources and scope

The official [KATOTTG edition 07.07.2026](https://mininfra.gov.ua/storage/app/sites/1/uploaded-files/kodifikator-07-07.xlsx) contains **31,744 nodes / 29,703 settlements**, including Crimea, Sevastopol and all 27 top-level regions. The two special cities are level-1 settlements. An oblast is category `O`; a special city is `K`. Codes, type and hierarchy establish identity; a repeated name does not.

`data/manifest.json` pins the original XLSX SHA256, edition, deterministic compressed JSON SHA256 and decompressed SHA256. Every build/import verifies the bundle. There are no personal addresses, private subjects or tokens in it.

Initial routes use all **22 Cherkasy branches** from `https://cabinet.cherkasyoblenergo.com/api_new/disconn.php` (`op=department_list`, then `op=city_list&dept_id=…`) and the existing public DTEK city dictionaries for Kyiv and Kyiv oblast. DTEK observations retain their original timestamps; the release date is not a claim of a fresh upstream check. Source dictionary availability is not API health or electrical coverage.

The bundle holds **2,196 provider city routes**, **2,276 candidate/reviewed links**, linked to **1,949 distinct settlements**. **218 routes remain unmatched**, and **480 links are ambiguous**. **67 service/aggregate source entries** were excluded. Matching uses exact normalized name + known type + region. Old districts in parentheses are retained as evidence, never equated with present administrative districts or electrical branches. There is no forced national name-only matching. Reviewed existing identities are Kyiv city and Cherkasy city Khrystynivka `18/801` and `3/100`. The village `18/818` has its own KATOTTG code.

## Opt-in HTTP contract

Both endpoints are public POST JSON with `schemaVersion: 1`, normal HTTP admission limits, bounded packets, `Cache-Control: no-store`, no required session and no upstream requests during typing. An Origin, if supplied, must equal the configured server origin. URL query parameters and unknown fields are rejected.

`POST /api/v1/settlements`:

```json
{"schemaVersion":1,"kind":"settlements","q":"Христинівка","regionCode":"UA71000000000010357","limit":30}
```

Optional `kind`: `regions`, `districts`, `communities`, `settlements` (default), `urbanDistricts`. Optional filters: `regionCode`, `districtCode`, `communityCode`, `parentCode`; identifiers must be complete current KATOTTG codes and use the declared administrative level. `q` is a normalized prefix, at most 120 characters. Limit is 1–50. Empty/one-character national settlement input returns no results; explicit administrative browsing remains paginated. `nextCursor` is opaque and tied to filters/edition; send it back unchanged, omit it for the first page. Responses include official code, name, type, parent and region/district/community breadcrumbs plus source edition. This is prefix matching, not fuzzy street/house matching.

`POST /api/v1/settlement-routes`:

```json
{"schemaVersion":1,"settlementCode":"UA71060230010046648"}
```

Returns `routeState` (`unknown`, `candidate`, `reviewed`, `multiple`), `routes` with operator, branch, provider city reference, optional existing catalogue city UUID, match method, number of candidate settlements, source URL and observation time. All routes require address verification and have `networkCoverageConfirmed: false`; the response has `queue: null`, `lineId: null`. Multiple routes have no selected/default branch. A regional operator hint has `branchConfirmed: false` and is explicitly provisional. Other regions remain searchable with `unknown` routes.

The next client step must verify street/house through the selected provider adapter, retaining alternate branch candidates when necessary. A candidate without `legacyCatalogCityId` is still a source reference, not a usable old-search UUID. It requires an explicit adapter lookup before the old address flow can consume it. Unknown routing does not mean a place/address does not exist or an independent sensor cannot be used.

400 is a malformed packet/filter/cursor, 404 a missing/non-settlement routing code, 405 an unsupported method, 413 an oversized body, 415 a non-JSON body, 429 normal admission limits, 503 unavailable directory. HTTP503 deliberately exposes only the existing generic error contract.

## Import, updates and validation

Migration `1015_settlement_directory.sql` creates only `svitlo_geo`. API/worker roles receive SELECT with RLS, no INSERT/UPDATE/DELETE/TRUNCATE or owner role. Only the migration owner calls `importGeography`. The bundle is imported atomically under an advisory lock; same-version retries are inert, and changed content under the same version fails. Replacing a name for an existing code retains its previous official name as a sourced alias. No speculative historical renames are bundled.

To update, obtain the official source edition and public provider dictionaries with actual observation timestamps; retain raw source artifacts and SHA256. Normalize columns A–E hierarchy, F category, G name. Reconcile counts, unique codes, parents and ambiguous names. Build a **new** bundle version/manifest; never change applied SQL or overwrite an existing edition identity. Initial preparation scripts and evidence are retained in the authorized workspace under `work/settlement-routing-20261105/` (`prepare.py`, `inspect-source.py`, `build-bundle.py`, source JSON/XLSX, `mapping-report.json`). Network harvesting is a maintenance action, not runtime or startup. Review new identities and unexplained count changes before releasing.

Run `node --test vps/geography/*.test.mjs` for real-bundle and embedded PostgreSQL checks. The release driver additionally restores a fresh disposable PostgreSQL database for **each** existing suite and the geography suite, applies 1015 and imports the exact reference before HTTP readiness. `prepare-qa.mjs`/`integration.mjs` reject non-QA database names. Real PostgreSQL/HTTP tests verify counts, identities, filters/pagination, permissions, generic failure behaviour, import idempotence, and hashes of original private/catalogue data. All original server suites must pass before live migration/slot switch.

Deployment requires an exact CI image/source archive, revision label, pinned SSH host, single deployment lock and current-release guard. Keep source-history/pilot-push and current PWA. Audit before/after profile configuration hashes, sensor ACL/history, subscriptions, old catalogue IDs and migration hashes. No VPS build, production migration, client rollout or automatic schedule inference is part of this package.
