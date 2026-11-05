# PWA-LIVE-30: suspended hourly reference and compact emergency notice

Approved 5 November 2026 for the isolated test PWA. The latest user correction replaces the proposed dashed outline with **gray diagonal hatching tinted coral**. Reference styling never draws a contour, so sensor observation contours and the current-hour outline remain independent.

- A validated saved publication for a suspended day supplies only a decorative half-hour reference layer. Its intervals never enter effective events, timers, summaries, reminders or sharing. Confirmed address intervals retain priority; reference hatching is painted only over otherwise unknown segments.
- The active emergency notice uses the approved short copy: «Аварійне відключення» / «Спеціалісти працюють над відновленням.» Queue scope does not become an address interval. A stale suspension is labeled «Збережений графік» and never promoted into a fresh queue status.
- The notice belongs to the selected day pane, including swipe transitions. An absent, invalid, unsupported or future-clock publication cannot create a reference layer. Restored applicability removes the layer. An empty publication draws no fictional reference.
- Time precision, raw cached source data, both icon/time styles, explicit sensor observations and source category priority are preserved. Existing saved sources are projected without a schema change. No additional provider query or DB migration is required.

Implementation: `pwa/live-model.js`, `pwa/app.js`, `pwa/live.css`. New behavioral tests: `tests/pwa-emergency-reference.test.mjs`.

QA and the deployment receipt are maintained outside the immutable release source at `work/pwa-live-30-20261105/`. Do not infer publication from this source note. Android and prototype runtime are independent and unchanged by this implementation.
