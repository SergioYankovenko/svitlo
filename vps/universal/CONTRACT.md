# BE-08 / Plan229 — universal API v1 (private staging)

Plan230 additive catalog policy: city search returns optional `routeState=available|unknown`; confirmed empty cities are excluded before pagination. Street search has `coverage=available|empty|unknown` and `emptyConfirmed`; `complete` only means pagination is exhausted, not source coverage. Literal service placeholders and their descendant paths are quarantined outside working search (raw IDs/aliases preserved). Resolve/snapshot of those UUIDs returns409 `address_requires_reselection`; legacy-resolve returns `needs_confirmation` with that reason. Saved profiles survive with `snapshot.addressRepair`, original history/source times and degraded unknown freshness. Administrative `catalog_link_city` requires a reviewed reference, preserves old-ID redirects and all separate streets. `catalog_route_state` accepts empty only with complete verification/proof; an error/unknown or older import cannot replace newer verified coverage. These admin functions and policy tables are readonly/inaccessible for runtime mutations. Branch3/100 is an identity alias of18/801 based on BE-01; branch3 streets/houses have not been imported. Synthetic fixtures are not real empty cities.

Additive `/api/v1` API. The existing `/api` profile transport stays available. No production routes, DNS, Supabase, APK, notifications or users change. First real adapter: Cherkasy, public catalog limited to the verified branch18 scope. Named QA operators/cities are synthetic and restricted to staging. Kyiv is not enabled by this work.

All public read requests accept JSON, optional `schemaVersion:1`, and no personal/server profile is required. Browser Origin must be the configured origin; native requests may omit it. No cross-origin credentials/CORS. Owned PWA actions still require cookie + CSRF and max10 profiles. Body16KiB; max10 snapshot items, max14 calendar days; search max50 records/cursor, literal query max120 chars. Inputs are data, never code or upstream URLs.

- `GET /api/v1/capabilities`: schemaVersion, contract version, supported types/timezones, search/batch/date limits, operators with support states, test flags and coverage notes. No hardcoded list of cities in clients.
- `POST /api/v1/search`: `{kind:'cities'|'streets'|'houses',parentId?,q?,cursor?,limit?}` → `{items,nextCursor,complete}`. UUID IDs, labels, optional verified district hints; house/street types and number suffixes are preserved. A page is never advertised as a complete catalog.
- `POST /api/v1/resolve`: `{addressId,lineId?,unit?}` → canonical address, operator, resolution (`resolved|excluded|ambiguous|unknown`), complete line set and provenance. Unit is conditional, transient and absent from public cache/logs/profile. Zero/multiple lines never select `[0]`. Explicit user choice is separate from an upstream apartment-to-line confirmation.
- `POST /api/v1/legacy-resolve`: `{legacy:{department,cityId,streetId,house}}` → exact canonical reference or `needs_confirmation`. Names/neighbor proximity do not invent an identity. Alias redirects preserve old IDs; queue changes do not change address/line ID.
- `POST /api/v1/snapshots`: `{fromDate?,toDate?,items:[{addressId,revision?}]}` → per-item snapshot/unchanged/error. `unchanged` requires the same revision and a fresh, interpretable snapshot; one failed item does not remove successful ones.

Snapshot v1: schemaVersion/revision/addressId/operatorId/timeZone/coverage/resolution/lines/notices/supportState/provenance/checkedAt/sourceUpdatedAt/freshUntil/refreshAfter. Each line has stable id, label, arbitrary bounded groupCode or null, supportedCategories, and per-date category states (`published|not_published|excluded|unknown|stale|suspended|unsupported`) and intervals with epoch-millisecond start/end (end may be null). Four categories: hourly/planned/unplanned/emergency. Empty intervals imply no scheduled outage only when that category/date is explicitly published or excluded and fresh. Regional emergency is a notice, never a manufactured 24h address outage. Physical power is not measured by this API.

Unknown major version, dangerous enum, timezone, malformed interval, partial line set or unsupported adapter fails closed. Unknown additive fields are ignored. Partial responses retain prior known lines; failed attempts do not renew source freshness. Epoch intervals preserve DST repeated hours, midnight and source boundaries. Display rounding remains30min; source evidence and future sensor timestamps are not rounded.

Reuse the existing shared source-cache claim/fencing mechanism and per-provider transport budget. Keys include operator/address/date range; no personal input. A valid stale snapshot can be retained on failure with degraded status and original source timestamps. Provider403/429/cooldown is never bypassed. Adapter code is server-side and allowlisted; no executable scripts from remote config.

PWA is upgraded once in staging to consume this contract, select city→street→house, and explicitly select among lines. Existing profile IDs/names/settings/cache survive an exact migration. Further compatible operators are server-only additions. The existing released Android still needs its first universal-client update; no server can teach its hardcoded parser a new protocol.

Vectors required before publication: exact Cherkasy frozen-source parity, stable aliases/group changes, two lines/conditional unit, partial line retention, explicit exclusion versus miss, unpublished/stale/failure/disabled operator, unknown enum/version, bad dates/batch/cursor, mixed batch/unchanged, midnight/DST, owner isolation, profile race, new compatible region without frontend hash change. Physical Android/Doze/push and public HTTPS deployment are separate gates.
# Saved plan presentation (PWA-LIVE-44/59)

An unavailable source may add `day.savedPublication` with basis
`previous_confirmed_plan`. It is bounded display provenance for the same
address, operator, line, group and calendar date, with original publication
clocks and at most seven days of age. It never replaces effective intervals.
A source-cache range miss may reuse the profile's last snapshot as degraded,
with freshness expired and the latest failure/retry metadata preserved.

The PWA may show a labelled `За графіком` estimate from this displayed plan.
This is not measured power, renewed source certainty, a notification or a
server reminder. Suspension, conflicting applicability and an open address
incident prohibit that estimate. A successful response supersedes this
fallback; genuinely unpublished data must not acquire a fictitious plan.



PWA-LIVE-45 r6 / 1024: a confirmed complete multi-line resolution for one exact canonical address expands through one atomic `svitlo_profile_group_create` RPC. The save response contains `profile` (first stable ordinal), `profiles` (line views) and `addressGroupId`. An owner has at most2 homes without entitlement or10 with active entitlement; canonical IDs, not line-view count, define homes. The universal32-line bound remains, with320 maximum line profiles per owner. Existing profile IDs and unresolved profiles with sensors are never silently reassigned. The sync response adds own-subject `addressQuota: {used, limit}`. Separate source identities/partial results continue to use the existing unresolved path. `lineNumber` is persisted per line ID, and profiles read use stable tie ordering.
