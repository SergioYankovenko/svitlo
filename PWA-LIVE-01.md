# PWA-LIVE-01 · private pilot

UI source: approved UI254, unchanged component CSS and shared policy/motion/tutorial modules (pwa/UI254-PROVENANCE.json). Runtime data comes only from the private same-origin VPS API; LAB transport and fixtures are excluded.

User-approved boundaries: test access without payments; no legacy migration; map search and multiple-line selection UI deferred; managed sensor ownership transfer deferred; forecast uses the approved unavailable state. Existing backend maps/Kyiv/phone/ARC and fd24e3f session/department cache changes are retained.

New private migration1012 adds opt-in sensor notice preferences/outbox and a separate pilot authorization flag. Legacy delivery_mode remains disabled for old-release rollback compatibility. Actual new process delivery reports pilot-enabled only with explicit deployment env plus DB authorization and a fresh mounted VAPID key. No VAPID secret is in source. Scheduled notices use existing delivery leases/retries; sensor notices validate active membership, binding epoch, reader link, consent and endpoint ownership at queue and send. Offline is never inferred as power-off. First samples do not replay notices.

Build: node vps/build.mjs. CI builds immutable image outside VPS, exact source hashes and current-release flock/backup/preflight guards are required. Keep physical camera, installed lifecycle, browser zoom and on-device push-display acceptance separate from controlled browser and SQL tests. External deployment receipts belong in work/pwa-live-v2-20261104, outside this source archive.
