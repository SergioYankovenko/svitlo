# PWA-LIVE-32–35: emergency history and presentation

Approved5 November2026; implementation remains separate from publication.

-32: a valid saved reference keeps the ordinary bolt/bulb on/off glyphs. Unknown effective evidence remains unknown; the reference is not a power measurement.
-33: confirmed archived official-plan periods remain visible during suspension. Historical planned outages use coral, as requested; original source categories/intervals remain unchanged. Only adjacent agreeing observations of the same plan bound a historical period. Failures, gaps over6 minutes, different revisions and unknown applicability break continuity. Archive observations do not establish physical power or an exact emergency onset. Actual address events and sensor history retain priority.
-34: an active emergency without a confirmed countdown says «Час відновлення уточнюється». A valid exact countdown remains unchanged.
-35: the sensor list disclosure SVG is centered within its existing48px control, including larger text.

Archive delivery requires additive migration1020_historical_plan.sql. It grants API and worker only a bounded read-only projection of public group/day plan observations; raw tables, payloads, observation hashes and collector controls remain inaccessible. No new provider request is added. Group/date cache and snapshot cache versioning prevent retaining old snapshots without the optional historical field. Clients that ignore the new field keep the previous behavior. Readiness requires the new projection after migration. The release process restores and tests a separate database before live migration/cutover.

The PWA history layer changes paint and accessible descriptions only. Effective events, exact times, totals, reminders, sharing and raw caches are not rewritten. No actual forecast algorithm, sensor access rule or production-user migration is added.

Local evidence:368 PWA tests,186 backend tests;411 reference/header assertions,483 historical-display assertions,271 disclosure/sensor assertions;20 real-SW/offline assertions. Two themes and320/360/414 widths,100/150/200 percent text, both time/icon styles are covered by the browser matrices. Physical devices and separate browser zoom are not accepted by these controlled fixtures.

Reports, publication state and any later CI/terminal receipts: work/pwa-live-32-34-20261105/. Publication authorized5 November2026 for the isolated test VPS. Final discovery backend9ea882a is merged, including1021/1022, the restored-QA connection budget and checkpoint alias fix. Preserve its coverage/territory maintenance configuration and obtain the sole deployment queue before cutover. The latest terminal receipt, not this note or a CI result, establishes publication.
