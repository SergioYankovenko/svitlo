# BE-06 · Plan233 · test sensor ingest and current signal v1

> Plan235 adds [phone producer3 batches](PHONE-CONTRACT.md) to this same HTTP endpoint:≤50events/16KiB,5min sample cadence/15min freshness, explicit boot/monotonic coverage and90-day phone history. Legacy producer1/2 retains the2048-byte/180s/7-day contract below. Control, reader, owner QR and ingest credentials are independent.


> Plan234 adds compatible protocol2 explicit coverage, an independent history journal and authenticated daily overview: [current history contract](HISTORY-CONTRACT.md). The protocol1 point-only and current-signal rules below remain in force. Interval history is now available for explicitly declared coverage; real firmware and prediction remain unimplemented.

Private VPS staging, baseline migration1006 plus history1007. Real hardware/firmware has **not** been enrolled or tested. Android/PWA/prototype/production are unchanged. This document describes protocol1 receipt handling/current point signal; protocol2/history/overview are specified separately above. Forecast, billing, transfer and recovery remain pending. Existing `capabilities.sensors=false` is retained; additive capabilities describe only implemented test features.

## Producer transport and credential

`POST /api/v1/sensor-events`, exact `Content-Type: application/json`, at most2048bytes, one packet. `Authorization: Bearer <ingestToken>`. No query string, cookie or browser Origin; no CORS. Existing private preview Host/SSH restrictions apply. A real device needs an authenticated HTTPS deployment in a later stage; do not transmit credentials over public HTTP.

SSH-only `vps/sensors/admin.mjs ingest-issue <bound-test-sensor-uuid> <epoch>` issues/rotates a256-bit random `st_` token and fresh server `streamId`. The token authorizes only that test sensor/current epoch/stream. Store SHA256 only; plaintext is shown once in the trusted admin terminal, not saved in the repository/image/log/report. It is independent of reader cookie, owner claim, viewer invitation and invitation HMAC secret. Runtime/reader cannot provision/rotate it; the API needs no device master key. `ingest-revoke <sensor> <epoch>` revokes it. Disconnect/old epoch fails even if its key was not separately revoked. Historical hashes are not readers' secrets or recovery proof.

The producer must retain a monotonic sequence across reboots. If it loses the counter, explicit admin rotation creates a new stream; sequence1 cannot silently reset the old stream. Rotation invalidates old key/stream and clears the new stream's current signal until a new sample. This test administration is not the manufacturing/recovery/ownership-transfer flow.

## Exact packet

All10fields required, no extra fields:

| Field | Type and rule |
| --- | --- |
| schemaVersion | integer1 |
| sensorId | UUID from enrolled test identity |
| bindingEpoch | integer1..999999999, current binding |
| streamId | UUID issued with the current ingest credential |
| eventId | stable UUID for the event; reuse exactly when retrying |
| sequence | monotonic safe integer1..9007199254740991, persisted by producer |
| eventType | `sample` or `heartbeat` |
| powerState | `on`/`off` for sample, JSON null for heartbeat |
| observedAt | canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ` if synchronized; JSON null otherwise |
| clockQuality | `synchronized` or `unsynchronized`; not a client-selected server time |

Producer state must come from a genuine electrical measurement in a future firmware integration. This backend cannot verify the honesty of a compromised physical device holding its credential. Network disappearance or the lack of a heartbeat does **not** report off. Hardware without backup power/network cannot report an off event merely by becoming silent.

Server owns receivedAt and freshness clock. Synchronized timestamps over5seconds ahead or over7days old are rejected. Up to5seconds ahead is tolerated by clamping confirmation time to receivedAt, preserving original observedAt; no future interval is created. Unsynchronized sample is accepted as untrusted evidence but does not assert a current state or timestamp. A heartbeat proves only receipt of a new packet; it never updates a power measurement timestamp.

## Receipt/order semantics

Success200: `{schemaVersion:1,accepted:true,duplicate,eventId,sequence,receivedAt,outcome}`. Outcomes: `sample`, `heartbeat`, `accepted_late`, `ignored_late`, `clock_untrusted`, `ignored_out_of_order`. No address/reader/ownership/secret data is returned to producer.

Exact retained eventId+sequence+normalized packet retry returns the original receipt, without a new row, transport freshness extension or state change. Changing a retained eventId/sequence conflicts409. Identity UUIDs normalize to lowercase before hashing. Receipt and latest state update atomically under a **per-device** row lock. Two consumers retrying one event commit one receipt; sequence races converge to the highest sequence, not last HTTP arrival. Missing sequences are explicit at the next point; no interval/gap is filled.

Higher sequence with older observedAt cannot replace a later confirmed point. A delayed synchronized sample can be retained as last confirmed evidence while remaining stale/unknown. Lower/old sequence without a retained receipt returns ignored_out_of_order and changes no state/liveness. After receipt TTL/cap eviction, conflict detection for that old body is unavailable; durable watermark still prevents replay from reviving evidence. Old credential/epoch is rejected before duplicate lookup.

400invalid/schema/time/query,401credential/sensor/epoch/stream unavailable (uniform),403browser Origin/cookie,405method,409changed duplicate,413oversize,415type,429throttle. Durable per-device120requests/minute is shared by both API slots; Retry-After60. Per-process admission has at most2in-flight ingestion DB operations, token bucket32/refill16persecond; busy returns429/Retry-After1 without an unbounded queue. Reader quotas remain separate. Use the same eventId/sequence/body after lost responses, bounded retry/backoff with Retry-After; never synthesize a new event for a retry. These are staging policies, not a measured production capacity guarantee.

## Authenticated current signal

`POST /api/v1/sensors` body `{schemaVersion:1,action:"signal",sensorId,bindingEpoch}`, current owner/viewer cookie+CSRF+Origin. No-store. Known UUID alone gives no access; revoked membership or old epoch404. Removing an address profile does not erase ownership or signal. No reader writes measurements.

Envelope `{schemaVersion:1,signal:{sensorId,bindingEpoch,measurementPointId,streamId,serverTime,powerState,availability,reason,transportState,lastReceivedAt,lastConfirmedState,lastConfirmedAt,observedAt,freshness,freshnessSeconds,clockQuality,sequence,coverage,isTest}}`.

Freshness policy180seconds, recommended test heartbeat60seconds. Current powerState on/off requires a fresh synchronized sample **and** fresh new transport evidence/current ingest credential. Otherwise unknown; retain lastConfirmedState/time separately. transportState online/offline/never_seen is independent of powerState. Heartbeat after an old sample may be online+unknown. New unsynchronized sample makes current state unknown until trusted fresh evidence; a later heartbeat cannot undo that. Compute stale at read time, without needing a worker timer.

`availability` available/unknown; reason null or not_provisioned/credential_revoked/no_confirmed_sample/clock_untrusted/stale_measurement. freshness fresh/stale/never_seen. coverage is **point_only**, continuous:false, sequenceGap describes the newest packet's preceding sequence gap. It is not a daily coverage array. Unknown is never converted to off/0; official schedules are not changed. Already returned/in-flight/offline copies cannot be erased by this server; client revalidation remains pending.

## Storage and boundaries

Four additional private RLS tables; existing NOLOGIN owner, API only ingest/signal functions, worker only bounded cleanup. No direct credential/event table access or public admin route. Producer path does not create anonymous reader sessions. Invalid input logging retains only BE-05 allowlisted metadata, no body/token/URL query. Receipts keep normalized measurement fields/hash, not raw JSON or Authorization. Server logs only static route/status/duration.

Receipts TTL7days, at most9999 per binding in normal operation (trim to9900 every100 new accepted events), bounded cleanup1000/run; no full table scan/count for every heartbeat. Latest watermark survives receipt expiry. Rotation retains old receipt data inside the same binding cap, not multiple unbounded stream buffers. Independent streams/epochs cannot contaminate the current point. Historical identity/sample erasure, long-term observations/downsampling/retention, manufacturing enrollment, secure secret backup, recovery, HTTPS/device QA, alerts and real hardware freshness/load characterization remain production gates.
