# BE-06 / Plan235 · phone enrollment and one-scan ownership

Private staging backend. Android sensor APK/main UI and PWA integration are separate gates. No production switch, firmware manufacture, payment, prediction or push. [Access foundation](CONTRACT.md), [legacy ingest](INGEST-CONTRACT.md). Plan234 uses producer2 for legacy explicit intervals; phone batches use **producer3**, avoiding a version collision. One sensor identity, bindings and owner/viewer memberships serve all producers.

## Device identity and secrets

`POST /api/v1/sensor-devices/register`, native JSON, no Cookie/Origin/query, ≤1024bytes:

```json
{"schemaVersion":1,"registrationToken":"sr_<32 random bytes, base64url without padding>"}
```

The producer creates and privately persists this 256-bit bootstrap secret **before its first request**. It is not an installation ID or hardware fingerprint. Response includes `sensorId`, `controlToken:sd_…`, `isTest:true`, `duplicate`. Retrying with the same bootstrap secret recovers the same identity/credential; UUID alone cannot. A different server crypto key fails closed. Registry cap1000, at most100 new identities/hour globally and30/hour per peer, unclaimed enrollment expires after24h. Bound sources are not silently deleted.

`POST /api/v1/sensor-devices/control`, same native transport, `Authorization: Bearer sd_…`, ≤1024bytes. Exact body `{schemaVersion:1,action,sensorId}`:

- `status`: bound/status/current epoch only; no reader identity/address/history.
- `owner_qr`: phone pairing screen obtains the active temporary QR. New random proof when none/expired/consumed.15min expiry, one successful new-owner consumption, no sensor confirmation. Opening the display repeatedly before use reuses the active QR instead of invalidating scans already in progress. Factory control credentials cannot reveal the sticker proof.
- `ingest_credentials`: only after binding, returns `{sensorId,bindingEpoch,streamId,ingestToken:st_…}`. Idempotent for this binding; a new binding gets an independent stream/key. It cannot recover an administratively rotated key under a different hash; fail closed rather than return a wrong token.

`sd_` (producer control), `st_` (ingest), `sp_` (phone owner QR), `so_` (permanent factory owner QR) and `si_` (viewer invitation) are separate capabilities. Ingest grants no reader/owner access. Reader cookies grant no ingest credentials. The phone control secret is private device management authority and must stay in app-private storage.

DB stores SHA256 proofs, and AES-256-GCM ciphertext where a credential must be shown again. Separate32-byte server key `/run/secrets/phone_secret`, file `/etc/svitlo/stage-secrets/phone-secret`, API only, outside Git/image. Random12-byte IV,16-byte tag, purpose+sensor AAD; ciphertext cannot be transplanted between sensor IDs or owner/ingest purposes. Preserve this key securely with database backups; restoring a DB alone does not decrypt credentials. No secret is placed in routine DTOs/audit/diagnostics/access logs/invites. Only explicit authorized registration/control/owner-QR responses contain their intended credential, all no-store.

Future hardware: admin-only test provisioner `admin_factory_phone(sensorUUID,controlHash,qrHash,encryptedQr)` supplies the permanent sticker model. No public factory provisioning or manufacturing/firmware is implemented. The sticker remains valid until separately rotated administratively. Its photo/copy also permits subsequent takeovers: this is the explicitly accepted ownership model.

## One scan in the main app

Authenticated `POST /api/v1/sensors`, normal cookie/CSRF/Origin and ≤4096bytes. Owner QR is structured data, no arbitrary host/URL to fetch:

```json
{"version":1,"kind":"phone_owner","sensorId":"<uuid>","proof":"sp_<43chars>"}
```

Other kinds: `factory_owner`/`so_…`, `viewer_invite`/`si_…`. QR rendering/decoding belongs to the future clients; never log the raw payload.

`{schemaVersion:1,action:"connect_qr",requestId,qr,profileId?}`:

- First connection requires an existing selected owned canonical `profileId`; creates binding epoch1/measurement point/owner. A real address must be chosen once, independently of scanning.
- Already-current owner → `next:"settings"`, no viewer/invite reset. A retry of the original request also preserves viewers.
- Different owner with valid proof → immediate atomic takeover. Existing binding address/line/epoch/measurement point and history remain. Select/create matching private profile; revoke **all** old memberships, reader links and invitations, including viewers and consumed invitations; create one new owner and link; bump access revision; save idempotency receipt. Ordinary old profiles/preferences remain.
- Actor+requestId is durable for30days. Identical retry only returns the current authorized membership, never repeats reset. A revoked actor cannot resurrect ownership with an old receipt. Changed request body409. A permanent sticker and a **new** requestId intentionally allow retaking ownership. Concurrent one-use phone scans: one winner, one409. Concurrent factory scans serialize; both may transfer successively by design, final transaction wins.
- Capacity/profile checks precede access replacement.10 memberships/actor and10 server profiles remain enforced. Profile creation and transfer share one transaction; rollback does not leave an orphan profile.
- Viewer QR uses existing atomic invitation acceptance, requires matching selected profile, adds a viewer and never transfers owner. Sensor ID is checked against the invitation before consumption.

Owner-only `{schemaVersion:1,action:"owner_qr",requestId,sensorId,bindingEpoch}`: phone creates/reuses a new temporary pairing QR; factory returns the encrypted current sticker QR. Viewers404/403. No recovery code/72h delay/extra confirmation.

Explicit address move: `{schemaVersion:1,action:"relocate",requestId,sensorId,bindingEpoch,profileId,confirmed:true}`. Owner only, different eligible owned address/line required. Ends old binding, revokes old readers/invites/ingest, creates a **new epoch/point**, expires old phone QR; source control fetches new stream/key. Old history remains retained against its original point; current-binding reads never mix it into the new address. Same request retry is inert. Scanning alone never moves the device. A disconnected/disabled source is not silently reactivated by a scan.

Valid main sessions with less than7days remaining extend to30days on API use, preserving cookie token/CSRF and **owner subject**. Server emits renewed cookie; expired/revoked sessions never revive. Future native client must retain the cookie jar; reinstall/lost credentials is a separate situation.

## Producer3 batches

`POST /api/v1/sensor-events`, native JSON/Bearer `st_…`, no Origin/Cookie/query. Hard wire limit **16KiB**, **1–50events**. Root exactly:

```text
schemaVersion:3, sensorId, bindingEpoch, streamId, events:[{
  eventId:UUID, sequence:positive safe integer,
  eventType:"sample"|"heartbeat", powerState:"on"|"off"|null,
  observedAt:canonical UTC ISO milliseconds|null,
  clockQuality:"synchronized"|"unsynchronized",
  bootId:UUID, elapsedRealtimeMs:nonnegative safe integer, monitorId:UUID,
  coverage:null|{startAt,endAt,startElapsedMs,endElapsedMs,powerState:"on"|"off"}
}]
```

Phone immediately queues a sample when external power changes, and samples current external power every300s while able to observe. A heartbeat-only packet has null power and never refreshes the power measurement. `BatteryManager.EXTRA_PLUGGED`, not `isCharging`, determines on/off: full battery or paused charging can remain plugged in. Missing/invalid reading is null/unknown. [Android API](https://developer.android.com/reference/android/os/BatteryManager#EXTRA_PLUGGED).

Both ordinary Wi-Fi and mobile/reserved links are supported by the same transport. No connectivity for15min → offline/unknown, separate lastConfirmed retained. Doze delays, lost network or process death do not prove an electrical outage. [Android restrictions](https://developer.android.com/training/monitoring-device-state/doze-standby). Physical Android behavior is a later APK/device test, not certified by this simulator.

Persist queue/eventId/sequence before sending, across process/reboot; new bootId on reboot and new monitorId after monitoring restarts. A restart must not assert continuous observation over the gap. A fresh synchronized event anchors wall time to elapsedRealtime for its boot; subsequent drift>5s makes evidence untrusted. Old unanchored boots stay unknown. UTC observation times cannot exceed server time+5s or be older than90days. Untrusted sample invalidates live certainty, retaining lastConfirmed. Trusted late/lower-sequence samples may add coverage but cannot roll current power back. Heartbeat and duplicate do not renew the last measurement; duplicates do not renew liveness.

Coverage is **an assertion of actual continuous monitoring**, not inference between equal points or timestamps. Nullable; only synchronized sample, `endAt=observedAt≤receivedAt`, `endElapsedMs=elapsedRealtimeMs`, exact UTC/monotonic duration agreement, maximum300000ms, start not before binding/credential issuance/90-day horizon. Interval power can describe the state **before** a transition at its endpoint. No coverage across missing monitoring/reboot/untrusted clock; source must send null. Authentic credentials cannot prove a compromised producer's physical honesty.

Receipt `{schemaVersion:3,sensorId,bindingEpoch,serverTime,acknowledged:[{eventId,sequence,duplicate,outcome}]}`. Delete local events **only after their exact ID/sequence ACK**.50events/16KiB applies to each chunk, not the whole offline queue. Retain unacknowledged events on partial/malformed ACK/network/429/503; bounded exponential retry with jitter.401 means reacquire current binding credentials;409 means investigate conflicting event identity, never mutate a committed event in place. A conflicting event rolls back the entire batch and returns no ACK. Sequence/epoch/stream/token are fenced before writes. Per-device row lock,120batches/min, shared HTTP admission2concurrent/process with token bucket; overload Retry-After.

`PhoneSimulator` exercises this queue contract, state serialization, power transition, monitoring gap and batching. It contains no Android service or production credential store.

## Current signal and exact90-day observations

Existing `signal` action automatically selects phone15min freshness, legacy producer180s is unchanged. Existing `overview` action automatically serves the phone day under `{schemaVersion:1,overview:{...}}`; `history` is an alias with the same envelope. One current owner/viewer ACL applies to all reads. No public cache; old readers immediately lose subsequent access.

Europe/Kyiv day bounds from PostgreSQL, real23/25-hour days.90UTC days retained; oldest local day may be partial, tomorrow has no fact. Exact intervals, no rounding/schedule mixing. Uncovered and conflicting spans are unknown; no coverage is not a confirmed zero-off day. Current signal remains independent of past-day observations. Prediction stays unavailable/not_implemented.

Explicit adjacent/overlapping same-state ranges coalesce **only** within one stream/boot/monitor run. Opposite evidence remains and projects to unknown overlap. Heartbeat updates latest presence and an idempotency receipt, never a separate historical measurement interval.90-day compact receipts contain only ID/sequence/hash/outcome/time, not raw event/secret; they do not invent history. Cap30000receipts/binding rejects429 **before dropping accepted90-day data**; maximum256boot anchors/binding. Query>2000ranges/day is explicit capacity_limited, not silently truncated. These are staging resource limits, not fleet capacity promises.

Worker bounded cleanup removes expired90-day receipts/anchors/ranges, clips a crossing range at the retention edge, expires unclaimed phones24h. Profile deletion/takeover does not delete physical history. DB/secret restore and backward compatibility are tested separately; public phone pilot requires protected HTTPS staging first.
