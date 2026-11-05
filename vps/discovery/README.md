# GEO-02 / GEO-AUD-01 — new PWA addresses and background diagnostics

The test PWA starts **new** address enrollment with region → community → settlement → explicit provider/branch choice. A community can be skipped when unknown and is filled from the chosen settlement. Kyiv and Sevastopol are special cities and do not require a fabricated community. Unsupported/unknown routes remain explicit. Existing profiles and pre-GEO onboarding drafts retain their identities and behaviour.

The selected route binds all later street/house requests. Many branches and ambiguous same-name settlements are never resolved by selecting the first result. Cherkasy uses real branch/city dictionaries and insert-only on-demand catalogue allocation; existing aliases, labels and source references are retained. DTEK uses the existing regional adapter with a checked city/parent binding. Full source house keys, including `8/а` and `10а/51`, survive selection and saving. Multiple supply lines require the user to choose before saving. No existing profile is migrated.

## Public endpoints

Existing `POST /api/v1/settlements` and `/api/v1/settlement-routes` retain their contracts. Two additional bounded public JSON POST endpoints use `schemaVersion: 1`, no-store, same-origin rules, no URL query parameters, existing admission limits and a 600/hour per-client search budget:

```json
// /api/v1/settlement-catalog: canonical city for an explicit reviewed/candidate route
{"schemaVersion":1,"settlementCode":"UA71060230010046648","routeId":"ua-cherkasy:18:801"}
// /api/v1/settlement-search: route-bound streets or houses, optionally q/cursor/limit (1–50)
{"schemaVersion":1,"settlementCode":"UA71060230010046648","routeId":"ua-cherkasy:18:801","kind":"streets","parentId":"<city UUID>","q":"Богуна","limit":50}
```

The city response contains `city` in the existing public catalogue format. Searches return `items`, `nextCursor`, `complete`. Parent UUIDs and street aliases must belong to the explicit route; body-supplied operator/source references/labels are rejected. A known provider city route does not prove building coverage. Actual address/line resolution remains the final check.

## Collector

An independent `discovery` Compose service uses the exact release image, 0.25 CPU, 256 MiB, read-only root, worker credentials and **disabled push**. It only observes public provider data and the service's existing registry; it does not allocate/repair catalogue rows, retire streets, update lines, modify profiles or alter sensor ACL/history. The API allocator is not executable by the collector's worker role.

PostgreSQL schema `svitlo_discovery` stores a durable queue, checkpoints, leases and observations. API/worker have no direct table read/write grants; worker has only constrained claim/finish routines. A single global 90-second lease and minimum 120-second interval prevent parallel crawls. The default cap is **360 work portions per Kyiv civil day**, not a promise of 360 HTTP requests. Providers rotate fairly; within each provider reviewed Khrystynivka, Kyiv and Brovary are initial priorities. A portion discovers one city street list or checks at most 50 houses on one street. Every upstream call still uses the existing shared provider gate/cooldown. No browser/map scraping, LS/account lookup, CAPTCHA/TLS bypass or paid geocoder is used.

After a completed city scan, public street references become diagnostic jobs. Successful street/house lists are compared against existing public provider aliases to identify absent entries. Empty and absent results are recorded only after a successful complete dictionary reply. Source errors, 403, 429, invalid data, unmatched KATOTTG routing and stale cached indexes are separate outcomes. The default retries are 30 minutes after 403, 15 after 429/unavailability, one hour after invalid source; provider-enforced longer cooldowns still apply. Completed tasks revisit after seven days. Source limits are explicit (maximum 5,000 public entries per dictionary, 250 observations per completion); excessive/malformed replies are invalid source data, never successful empty coverage.

House batches retain a source-list digest and offset. A changed list starts from offset zero; restart/lease loss never silently skips the remainder. Daily observations are deduplicated by source reference/outcome, preserving separate first/last observation times. Queue exclusions, estimates, partial groups, ambiguous lines, another provider, unknown/stale registry and confirmed groups are distinct. **Cherkasy queue checks use the service's local curated/PDF registry, not personal accounts or an independently verified provider allocation.** `basis`, registry version/review time and estimate flags make that distinction inspectable. DTEK groups come from its public address response. Neither result asserts physical power.

The journal records public branch/city/street/house references, outcome, basis and source time; no profile owner, session, QR/ingest/control/push token, LS/account or raw upstream payload is stored. Last observation time is not substituted for an old source review time. Observations are retained for 90 days and cleaned in batches of 1,000. Human actions and normal live source/QR/history updates continue during releases; no stale baseline is restored over them.

## Administrative clusters and progress

Collection follows **oblast/special city → rayon → hromada → settlement → provider route → street → house**. The normal work unit is a hromada. Each provider retains its active community in PostgreSQL and finishes its eligible source routes/street portions before moving to another community. Providers rotate fairly, so one large community does not monopolize the other regions. A waiting source retry retains its unfinished state; other ready communities may continue. Reviewed Khrystynivka, Kyiv and Brovary are initial priorities, then administrative codes give stable traversal order.

Every job and observation has a server-assigned KATOTTG cluster. Unique city/village matches retain separate settlement codes inside their community. If candidate settlements share only a rayon or oblast, the route remains at that common ancestor; no arbitrary community or settlement receives its progress. Unmatched routes are held at the region with an explicit mapping gap. Street jobs inherit the same cluster and source route, so restart and later code releases retain progress.

The private report rolls up tasks once through the official hierarchy. Region totals reconcile to the physical queue; ambiguous work is not multiplied across all possible settlements. It shows route-list discovery, known street tasks/completions, checked source-house references, retries, missing routes and grouped outcomes. City lists discover the denominator dynamically; the street count is marked incomplete while source lists or mapping remain unknown. Percentages concern discovered source tasks, and **never establish complete geographical/electrical coverage**. House counts concern source references, which may include multiple branches for one physical address.

## Operator report and stopping

From the active test release, with normal deployment administration access:

```sh
docker compose --env-file vps/release.env -f vps/compose.yaml run --rm --user 0 --entrypoint node migrate vps/discovery/report.mjs
# Include successful source/queue observations too:
docker compose --env-file vps/release.env -f vps/compose.yaml run --rm --user 0 --entrypoint node migrate vps/discovery/report.mjs --all
# Drill into the Khrystynivka community; an oblast/rayon/settlement code works too:
docker compose --env-file vps/release.env -f vps/compose.yaml run --rm --user 0 --entrypoint node migrate vps/discovery/report.mjs --cluster UA71060230000095772
# Stop network observations without changing saved data:
docker compose --env-file vps/release.env -f vps/compose.yaml stop discovery
```

The private report returns budgets, queue progress, outcome counts and up to 100 public-source examples. It is not a public HTTP endpoint. Changing `policy.enabled` is owner-only; never grant the client permission to alter it. A rollback below migration 1016 should stop `discovery`; the additive schema can remain for audit history.

## Release validation

All previous 125 restored PostgreSQL/HTTP checks remain gates. The new discovery suite covers real role permissions, two independent claims, expired lease recovery, atomic completion, source failures, no repair side effects, real route-scoped HTTP, exact house numbers, branch changes and isolated new-profile enrollment. Embedded SQL tests additionally exercise checkpoints, source-list changes/staleness, budget persistence and source classification. Browser QA checks new and additional enrollment, same-name places, Kyiv/oblast, unsupported routes, pagination, retry, narrow viewport, draft reload and explicit line choice. Deployment uses one immutable CI image/source archive and the current-release guard; production and native Android are outside scope.
