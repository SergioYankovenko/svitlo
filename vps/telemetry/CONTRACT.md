# Plan231 · BE-04/BE-05 · private staging server contract

This is the server implementation on isolated `svitlo_staging`. Production, existing Android/PWA, prototype runtime and notification delivery are unchanged. The staging PWA has no report collector/button integration yet. Public BE-08 catalog/snapshot reads remain anonymous; private reports use the established cookie owner and CSRF transport. `client.target=android` is metadata, never ownership proof.

## Explicit diagnostic submission

`POST /api/v1/diagnostic-reports`, alias `POST /diagnostic-reports`. Same origin, `Content-Type: application/json`, valid HttpOnly session cookie, `X-Svitlo-CSRF` and `X-Svitlo-Diagnostic-Consent: <reportId>` required. Browser fetch uses credentials on the same origin. No admin/API service key is sent to clients. Native integration first needs the authenticated session/Origin/CSRF transport; installationId is insufficient.

Payload: [report.schema.json](report.schema.json), identical to the prototype BE-04 v1 schema. Limit8192raw UTF-8 bytes,1–8events, no unknown keys at any level. Example (generate a new UUID and time only when constructing a new consent preview):

```json
{"schemaVersion":1,"reportId":"9e4f5612-8c4b-47f0-b857-a98a2fd45675","client":{"target":"pwa","version":"1.2.3"},"occurredAt":"2026-11-03T12:30:00.000Z","stage":"street","code":"temporary","events":[{"name":"lookup_failed","code":"temporary"}]}
```

Optional `httpStatus`100–599. Optional `correlationId` must come specifically from server `X-Svitlo-Request-ID`, not any auth/session header. It is a signed, scope-bound trace token (at most24hours old); the server checks HMAC and owner/public scope, then persists only its UUID. A regex-shaped arbitrary token is rejected. Correlation is checked on each submission; omit it when unavailable, never copy a credential into it. Signing uses a separate HMAC namespace from CSRF. The token is not an authorization credential.

201 JSON `{schemaVersion:1,reportId,receiptId,acceptedAt}` only after DB commit;200same receipt for the same validated packet/owner/reportId;409if packet differs. Canonical JSONB hash makes key order/whitespace immaterial. Another owner gets an independent receipt for the same reportId and cannot read the first report. No public report-read or admin endpoint exists. A lost response is not proof that nothing was committed: retry the same ID and packet.

5new reports/owner/UTCday; duplicates do not consume that quota.429carries Retry-After; capacity refusal also429/60s. An additional private-preview proxy-peer abuse budget is300attempts/hour, separate from the existing4000API requests/hour and30session creations/hour; counters contain no persisted IP. Public production trusted-proxy quotas remain a separate infrastructure gate.400invalid packet,401session,403origin/CSRF/consent,413size,415media,503storage unavailable; no successful receipt is fabricated on storage failure.

Payload retention up to30days; minimal owner/reportId/hash/receipt up to35days, or earlier authenticated erasure/owner removal. No dedupe guarantee after receipt expiry. Worker purges bounded1000rows/table/tick. Authenticated `/api` erase removes this owner's receipts and payloads too. No raw address, account, log lines, stacktrace, URL, device identifiers or credentials are part of this schema.

Client work still pending: bounded sanitized event buffer; visible preview, explicit click, cancel with no deferred queue, at most2explicit attempts using the identical packet/reportId, Retry-After and abort handling. Cancellation after an HTTP request began cannot guarantee rollback of a committed report. Existing client flows do not automatically submit anything. Server consent-header checks and HTTP tests do not substitute for native/browser UI acceptance.

## Metadata-only input journal

Only the server creates events: server UUID/time, operation/field/reason/confidence/source and optional server correlation UUID. No payload/excerpt, owner/install ID, address, IP, headers or client text columns. Ordinary empty results, unpublished schedules, valid apostrophes/Unicode/SQL words, and upstream transport403/429/5xx are not input violations. Schema/control/operation/owner/rate rejections use fixed metadata; no heuristic punishment or keyword blacklist is introduced.

Private staging policy: global atomic60s operation+field+reason dedupe,30new events/min,2000active events capacity, TTL14days. An in-process queue is bounded32pending entries; the DB transaction enforces caps across processes. Collection is best effort: overflow/contention/sink failures may drop metadata; they never skip validation or block valid requests. There is no raw-input fallback log. Application request logs contain an allowlisted route tag, status and timing, never arbitrary URL paths. These knobs/privacy wording need production review before rollout.

## Storage and administration

Migration1004 creates private `svitlo_telemetry` with5RLS-enabled tables and NOLOGIN/NOSUPERUSER/NOBYPASSRLS function owner. The dedicated owner accesses its own tables through SECURITY DEFINER functions with an empty search_path; runtime roles have no direct table access/role membership. API can submit a validated own report, erase own reports or append bounded security metadata. Worker can only purge. Admin reads and collection toggles have no runtime execute grant.

Administrative interface: `vps/telemetry/admin.mjs diagnostics|security [1..100]` or `collection on|off`, executed by the trusted SSH administrator in a one-off container mounting the owner credential outside public API/worker containers. It invokes allowlisted DB admin functions and records session_user/operation/count in a bounded audit trail (up to1000rows/90days). The SSH account/key/sudo boundary authorizes the administrator; this is not a public dashboard or new browser token.

From `/opt/svitlo/staging/current` on the VPS:

```sh
image=$(sed -n 's/^STAGE_IMAGE=//p' vps/release.env)
docker run --rm --network svitlo_backend --user 0 \
 --mount type=bind,src=/etc/svitlo/secrets/postgres-owner-password,dst=/run/secrets/owner_password,readonly \
 --entrypoint node "$image" vps/telemetry/admin.mjs security 20
```

Switch the final arguments to `collection off` for BE-05 rollback. Validation/ownership remain active; the table and retention are preserved. Applied SQL1004 is immutable; future fixes use additive migrations. API versions before telemetry lack these routes and are not semantically equivalent fallbacks. Offsite backup, owner alerts, HTTPS/device QA, CI and production privacy/cutover remain separate gates.

## Verification

Unit schema/correlation/control/bounded queue/failure tests; real PostgreSQL role/RLS/idempotency/race/quota/TTL/cap/audit tests; private HTTP fault injection in a disposable restored DB with no published port; primary staging consent/boundary/owner/receipt tests; real dual-slot same-report test; existing universal/catalog/profile/live regressions. No provider crawl, forced provider rate limit or production write is part of these tests. Browser/native consent UI is pending.
