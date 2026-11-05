# PWA-LIVE-31 — sensor overview

Approved 5 November 2026: hide an absent prediction panel; disable tomorrow and reject navigation/swipes without a formed forecast; use the existing plug/status mark in the header, retaining an accessible full state and signal time. History remains available. The selected sensor supplies the status.

No prediction algorithm, synthetic data, API/schema migration, rights change or production migration is introduced. The current backend has no prediction; tomorrow therefore remains disabled.

Validation: 366 PWA tests pass; 469 controlled browser assertions pass across 36 contexts: dark/light, widths320/360/414, on/off/unknown/offline; unknown at100/150/200 percent text. They cover hidden empty prediction, disabled tomorrow, swipe rejection, yesterday/today navigation, correct icon tone, accessible label, right alignment and no horizontal clipping. Physical-phone acceptance is pending.

Publication is recorded separately in work/pwa-live-30-20261105/QA.md and the immutable terminal receipt. Local completion alone is not proof of deployment.
