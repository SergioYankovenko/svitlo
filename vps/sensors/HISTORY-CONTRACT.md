# BE-06 · Plan234 · explicit observations and daily overview v1

Private test VPS only. Additive SQL1007; Android/PWA/prototype/production unchanged. [Identity/access](CONTRACT.md), [legacy producer/current signal](INGEST-CONTRACT.md). Real electrical measurement/firmware is not validated. No prediction model, billing, recovery, transfer or production cutover is implemented here.

## Evidence, not interpolation

Protocol1 remains accepted and journaled as **points only**. Two equal point samples do not prove the time between them, and silence/heartbeat/lastConfirmed never fills history. Old retained receipts are backfilled only as points; missing old receipts or intervals cannot be recovered by inventing coverage.

Producer protocol2 on the same POST route adds one required field `coverage`: JSON null, or exactly `{startAt,endAt}`. Other10fields/credential/size2048bytes remain as in protocol1. Non-null coverage requires synchronized sample on/off, canonical UTC timestamps, `startAt < endAt = observedAt`, duration≤180seconds, endAt≤server receivedAt, startAt≥both binding start and current credential issuance. It explicitly asserts that the measured state held continuously for that entire interval. Null coverage is point-only. A heartbeat/unsynchronized sample cannot assert a covered interval. Firmware must measure this interval, not infer it merely from connectivity or two point samples.

Interval bounds cannot extend before a new epoch/stream was authorized. A rotated key cannot upload buffered measurements under the old stream. Old credential/epoch is rejected before history lookup. Authenticity of a key does not prove the physical truth of a compromised producer.

Full body fingerprint includes protocol version and coverage. Exact retries return one durable event/receipt; changed coverage/version/state with the same retained eventId/sequence409. Do not upgrade/downgrade an existing event in place. Legacy code still using the old ingest SQL during a rolling deploy is captured by a private receipt trigger, preserving point-only semantics. That trigger and the v2 wrapper share the per-device transaction lock; new interval/hash upgrade is atomic inside that transaction, never visible as a half-written record.

Delayed/out-of-order v2 interval evidence may fill historical gaps without rolling back current signal/watermark. Contradictory overlapping on/off assertions are both retained, and their exact overlap becomes unknown. Same-state overlap counts once. Touching same-state intervals merge; no bridge across a missing span is created. Different streams remain explicit in interval `streamIds`. Journal-backed duplicate detection can outlive the shorter receipt buffer; duplicates never extend transport or measurement freshness. Once all evidence for an old packet expires/evicts, its conflict cannot be established; source-age/stream/sequence constraints still apply.

## One authenticated day read

`POST /api/v1/sensors` with `{schemaVersion:1,action:"overview",sensorId,bindingEpoch,date:"YYYY-MM-DD"}`. Current reader cookie+CSRF+Origin, current owner/viewer membership, no-store. No query strings/public history/admin endpoint. Reader phones do not receive producer keys or create measurements. Invitation grants history for the **current binding epoch**; it does not grant earlier epochs/previous owners. Removing a saved address profile does not erase ownership/history. Revocation/old epoch denies subsequent reads404; already returned/in-flight/offline data needs client revalidation.

Response `{schemaVersion:1,overview:{...}}`:

```text
overviewVersion:1, sensorId, bindingEpoch, measurementPointId, canonicalAddressId, lineId
date, timezone:"Europe/Kyiv", dayStartUtc, dayEndUtc, dayLengthMinutes, asOf
revision, horizon:{fromDate,toDate,historyDays:7}
signal:{...current signal contract,scope:"current_binding"}
observation:{availability,reason,complete,points[],intervals[],coverageBounds[],gaps[],issues[],
             through,summary:{onMs,offMs,knownMs,unknownMs,elapsedMs,futureMs},
             semantics:"explicit_coverage_only"}
prediction:{availability:"unavailable",reason:"not_implemented",intervals:[]}
capabilities:{history:true,overview:true,prediction:false,testOnly:true,limits}
```

Signal describes **current binding now**, not a reconstructed past-day state. Observation is independent of official schedules, Home overlays and current transport availability. Completed past evidence is retained when the device is offline. Forecast is never copied from an official schedule or synthesized to fill a missing day.

Date bounds come from PostgreSQL's Kyiv timezone: current local date−6 through tomorrow inclusive. Outside horizon409; invalid calendar date400. DST days have1380/1500 real minutes and UTC bounds, preserving repeated/missing local hours. No24-hour assumption. API returns exact milliseconds, not30-minute display rounding.

`points`: eventId/streamId/sequence/at/receivedAt/powerState/evidence:"point". Only synchronized sample points inside the selected day, binding and asOf are returned; they add no duration. `intervals`: start/end/powerState/streamIds[]/evidence:"declared_coverage", clipped to selected day and elapsed asOf. `coverageBounds` contains their confirmed bounds. `gaps`: start/end/reason(no_coverage, before_binding or conflicting_evidence), complement of known elapsed coverage. `issues` identifies sequence_gap, clock_untrusted and delayed_or_out_of_order events without inventing precise unknown interval boundaries from sequence numbers alone.

Availability available means the elapsed day is fully covered; partial means positive coverage plus gaps; unavailable means no confirmed interval or capacity failure. `complete` refers to completeness of the **bounded source query**, not physical coverage. Reasons include point_only/no_declared_coverage/before_binding/future_day/capacity_limited. onMs/offMs are null when no durations are available; a real measured zero, such as onMs0 in an off-only interval, is numeric0. Unknown is excluded from known totals and never padded to24h. Future day has no measurements, through:null, elapsedMs0, futureMs=actual day length and null on/off. Today’s future tail is not an unknown past outage.

Query reads at most5001 rows to detect overflow; >5000 makes complete:false/capacity_limited with empty evidence and null duration/unknown totals. It does **not** silently present truncated data as a complete day. Row/time/identity/source corruption or storage failure returns503, not no-data or a clear schedule. Valid unknown states are200. `revision` hashes retained source identity/date/events, not authorization or freshness; every request still checks rights and has fresh asOf. There is no private server cache/ETag reuse in this phase.

## Storage and operations

Two more private RLS tables (15total): history_events and history_counters. Narrow API ingest_with_history/day_source functions; private trigger/bump helpers cannot be called by runtime, bounded history_cleanup is worker-only. No raw body/token/hash is exposed by overview or logs. DB stores normalized fields and full fingerprint, no Authorization. API/worker still have no owner credential. Legacy ingest function remains granted for compatibility, with the same device proof and trigger; no arbitrary SQL endpoint is introduced.

History retention7UTC days (receivedAt or observedAt), normal cap≤19999events/binding independent of receipt cap9999. Trim to19900 every100new history events, at most1000removed/batch; worker TTL cleanup at most1000/call. Counters are monotonic trim cadence, not an exact current row count. Epoch purge of an inactive **test** identity cascades its journal; reader profile deletion does not. Current seven-calendar-day horizon is a query limit, not a promise of complete coverage at retention edges or after eviction.

Minute cadence and stated limits are staging policy, not measured fleet capacity. Production needs genuine firmware coverage validation, clock/sequence behavior under power/network loss, agreed cadence/retention/downsampling/entitlement, HTTPS, identity recovery/erasure, offsite DB+secret backup/rotation, alerts/CI and native/browser/physical-device QA. Historical source revisions are asOf reads and can gain late evidence; they are not immutable issued predictions.
