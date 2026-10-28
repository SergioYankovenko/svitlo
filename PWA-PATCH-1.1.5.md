# PWA 1.1.5

28.10.2026. One sync request, owner-bound hourly cache, shared city weather and address dictionaries, durable push invalidation. Explicit no-GPV coverage remains separate from unknown data. Independent first-publication/change notification settings with legacy migration; confirmed address emergencies only for system push, regional warnings remain in the feed.

Compact address, appearance and notification controls; new legend, Ukrainian message/share text and install link; donation action on Home. Small weather attribution retained. Matching time font weight in both tile modes, one-line address names, SVG selection indicator and clearer light-theme action buttons.

215 automated tests and local build passed. Native browser zoom and final visual verification of the last UI refinements remain unconfirmed; no real push test was run.

Backend contract and deployment order: PWA-SYNC-CONTRACT.md. Immutable, already bundled Edge sources in supabase/releases/pwa-1.1.5 are the exact server build for this release; deploy with authenticated handlers and existing environment settings. No registry/Android deployment is part of this PWA update.
