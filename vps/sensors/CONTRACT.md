# BE-06 · Plan232 · sensor access foundation v1

> **Current Plan235 extension:** [PHONE-CONTRACT.md](PHONE-CONTRACT.md) implements phone registration, owner QR/atomic transfer, explicit relocation, producer3/90-day phone history and sliding reader sessions on the same memberships/API. This supersedes the earlier transfer/recovery exclusions for enrolled phone/factory-test sources. The foundation behavior below still describes legacy test identities. Viewer QR remains an invitation, ingest proof never grants ownership. SQL1009 preserves history1007/map1008; private staging only.


Private staging only. No app/prototype/production change. Plan233 adds test-device ingestion/current point signal; Plan234 adds [explicit observations/history/daily overview](HISTORY-CONTRACT.md). Real hardware provisioning/firmware, prediction, billing, transfer and recovery remain **not implemented**. All devices are explicitly test-only. Existing `capabilities.sensors=false` is preserved; additive capabilities describe implemented test features. No state is inferred from silence or an official plan.

## Identity and ownership

`sensorId` is a server UUID, not a secret or a hardware fingerprint. `bindingEpoch` increments on a new claim after an ended binding; each epoch has an independent `measurementPointId`. Canonical address/line attach to that physical-point binding. Reader names/phones/profile IDs are not sensor IDs. Rename/delete/reset of an address profile does not delete the physical binding, another reader or ownership.

Current staging enrollment requires an **existing own server profile with a canonical address**, using the established session owner. This fits the staging PWA. Android local-only profile registration/ownership transport is a separate future integration; do not silently move all Android profiles to the server. Profile IDs and installation IDs alone never authorize anything. Private memberships require cookie+CSRF+same origin; read-only BE-08 public catalog remains unchanged.

Maximum10active sensor memberships per reader (owner+viewer); one sensor per saved profile, one linked saved profile per sensor/membership for that reader. Multiple readers share the same point and sensor. Different people may have different physical points in the same building: no global uniqueness by street/house is invented. A reader's target profile must match the binding's exact canonical address and line. No implicit replace/move or neighboring-address guess. Deleted profile removes only its link; the unlinked sensor remains in the private list and may be explicitly linked again. `leave` is a viewer access removal; ending the whole binding requires explicit owner `disconnect`.

## Private HTTP protocol

`POST /api/v1/sensors`, JSON up to4096bytes, no query string, authenticated HttpOnly cookie + `X-Svitlo-CSRF` + same-origin Origin. Envelope `{schemaVersion:1,action,...fields}`. Unknown fields/types/actions rejected; client-selected role/owner/installation/expiry is not accepted. All writes carry a UUID requestId and are atomic/idempotent. Sensor control has its own durable120requests/min/subject counter, independent of profile API quota. Responses are no-store. No public sensor/admin GET or private data cache exists in this phase.

| Action | Required fields beyond version/action | Authority / result |
|---|---|---|
| list | none | Own active memberships, at most10; unlinked entries retained |
| get | sensorId,bindingEpoch | Current active member, identity DTO |
| signal | sensorId,bindingEpoch | Current active member, current point/transport freshness; Plan233 contract |
| overview | sensorId,bindingEpoch,date | Current active member, bounded Kyiv daily observations/gaps; Plan234 contract |
| claim | requestId,profileId,claimToken | Valid one-time bootstrap + own eligible canonical profile; creates owner/point/epoch |
| members | sensorId,bindingEpoch | Owner; active opaque membership IDs/roles/join time and pending invite metadata, no peer profiles/subjects/secrets |
| invite_create | requestId,sensorId,bindingEpoch | Owner; viewer-only invitation, returns secret inviteToken |
| invite_inspect | inviteToken | Authenticated bearer of a live unused invite; canonical address/line and point context, no ownership/history |
| invite_accept | requestId,inviteToken,profileId | Atomic single consumer + own matching profile; creates viewer |
| invite_revoke | requestId,sensorId,bindingEpoch,inviteId | Owner; stops token use; does not remove an already-granted membership |
| member_revoke | requestId,sensorId,bindingEpoch,membershipId | Owner; cannot revoke the owner; removes that specific viewer and link |
| leave | requestId,sensorId,bindingEpoch,membershipId | That viewer only; owner must use explicit disconnect |
| link | requestId,sensorId,bindingEpoch,profileId | Active member and unlinked exact matching own profile; no silent move |
| disconnect | requestId,sensorId,bindingEpoch,confirmed:true | Owner; ends epoch, revokes all memberships/invites, disables device |

Success200JSON: `{schemaVersion:1,sensor:...}`, `{sensors:[...],complete:true}`, `{invitation:...}`, `{members:[...],invitations:[...]}`, `{signal:...}`, `{overview:...}` or `{completed:true}`. Identity DTO contains sensorId,bindingEpoch,measurementPointId,canonicalAddressId,lineId,membershipId,role,accessRevision,own readerProfileId|null,isTest. Plan233 adds test-only telemetry/ingest/signal; Plan234 adds explicit observations/history/overview. Prediction/transfer/recovery remain false. No owner subject, raw bootstrap, hash, nonce or ingest credential is exposed. Only explicit owner invite_create returns a short-lived viewer token.

400invalid/unsupported packet,401session required,403owner required/CSRF/Origin,404not available (known sensor UUID does not reveal another user's sensor),409request conflict/cardinality/wrong profile/used invite/owner-needs-disconnect,413size,429rate/pending cap with Retry-After60. Lost response retries use the same requestId and fields. Same ID with different fields conflicts. Replay is not cached authorization: claim/accept/link responses require the original still-active membership/epoch; revoked access is not recreated. Revoke/leave/disconnect replays acknowledge the previous operation without executing it against a new grant. A fresh membership has a fresh ID, so an old revoke does not remove it.

## Proofs, invitations and administration

Bootstrap `sc_` plus256random bits; independent viewer token `si_` plus256-bit HMAC. Proofs are sent only in POST body and are transformed to SHA256 before SQL. Store hashes only. No DEMO code, deviceId or client role grants access. Staging claim expires24h; invite15min, at most5pending and20viewers/sensor (temporary abuse policy, not approved commercial quotas).

Viewer response retry is recoverable without plaintext DB storage. An independent API-only secret signs owner+sensor+epoch+requestId+server-generated nonce. The first nonce/hash is persisted in the invitation; a same-request retry reads that nonce and returns the same token. Old receipt deletion does not revive an old token because a new issuance gets a new nonce. Expired/revoked/consumed invites cannot be reused; consumed membership pointers and epochs prevent regrant after revoke/rebind. Key mismatch fails closed. This key is not the session/messages secret and **not an ingest master credential**.

Secret file `/etc/svitlo/stage-secrets/sensor-access-secret`, root:1000/0640 in protected directory, readonly mount only in API. No value/hash is put in Git, image, workspace report or application log. Worker gets no invitation signing key or DB-owner credential. Backup/restore of DB is verified on the same host; independent secure secret backup/rotation remains a production gate.

SSH-only `vps/sensors/admin.mjs provision`, `reissue <inactive-test-id>`, `purge <inactive-test-id>`, `list`, using the existing trusted owner credential in a one-off admin container. Provision/reissue prints a **secret** claim code for an explicitly test identity; do not capture it in reports/public logs. Reissue of a bound device is prohibited; global disconnect is not a recovery or transfer shortcut. Purge applies only to inactive test identities with no real measurements in this phase. No client/admin web endpoint is added.

## Database/privacy/lifecycle

Migration1005 added9private RLS tables, NOLOGIN/NOSUPERUSER/NOBYPASSRLS function owner and closed direct runtime access. Plan233/1006 adds4private ingest tables; Plan234/1007 adds2history tables (15total), narrow history-aware ingress/day read and bounded worker cleanup. High-frequency ingest locks only its physical device. API cannot call private helpers/claims/admin provisioning directly. Own-profile SELECT has an owner-scoped RLS policy. Session cleanup retains durable sensor subjects so deleting a profile cannot orphan identity or cause FK cleanup errors. Low-frequency management transitions still serialize in the DB.

Command receipts30days, mutation-only audit up to10 000rows/90days, expired invites up to30days, counters1day; cleanup is bounded. Historical identities/memberships/bindings are not automatically reassigned or erased by an app reset; full physical-history retention/account erasure needs the next policy. Private audit contains actor/sensor UUID and operation, no profile label, token or payload. BE-05 adds only the `sensor_access` metadata category; normal reads do not create mutation audit records.

Staging anonymous sessions last30days. Ownership persists after a lost session, but no recovery/reinstall/transfer flow is implemented; a new installation ID cannot recover it. Before real hardware/users: long-lived identity/recovery, manufacturing enrollment and ingest credentials, entitlement, retention/erasure, private offline-cache revalidation, HTTPS/native/device tests, secret/offsite backups, alerts/CI and authorized cutover. Revocation denies subsequent server reads after commit; already returned/in-flight/offline data cannot be remotely erased by this backend alone.

Android/PWA integration and UI prototype remain pending. Keep explicit role menus, same requestId retries, no URL tokens/automatic invitation sending, exact profile/point/epoch and local display names. The current source prototype still uses local synthetic fixtures, not this live API.


PWA-LIVE-45 r6 / 1024: one reader link per canonical line-profile permits independent sensors for different lines of the same home. Membership/list bounds are320 (10homes ×32lines); one active profile cannot accept a second sensor. The same main-app subscription covers all permitted line sensors; transfer, QR expiry/consumption, revocation, measurements and membership checks are unchanged. Entitlement adds `addressCounting: canonical_home`, `maxSensorsPerLine:1`, `maxLinesPerAddress:32`; the legacy `maxSensorsPerAddress:1` remains a per-visible-profile compatibility field so older staged clients remain usable during blue/green promotion. Free2/premium10 quota is enforced separately by logical home. No existing sensor or profile is reassigned by the migration.
