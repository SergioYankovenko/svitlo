# ARC-06 · authority and migration contract · private staging

Status: decisions and executable dry-run validator. No live user migration or production writes.

## Authority

| Data | While old clients work | After an explicit migration |
| --- | --- | --- |
| Address, local name, preferences | User device; PWA's existing Supabase owner profile where present | Preserve local copy; server stable canonical address ID, user edits stay private |
| Official queues/plans | Official operator evidence; curated Cherkasy catalog remains separate evidence | VPS adapters/catalog are the delivery layer, with provenance/revision/freshness; an old cache does not reconfirm a line |
| Sensor identity, owner/viewers, epoch, fact history | Private VPS sensor records | Same VPS IDs; never import ownership or power history from client JSON or a street match |
| Legacy Supabase profiles/messages | Current Supabase contract | Coexist until that client migrates; never reuse one user's owner ID as another user's new account |

## Gates and transfer

1. Capture signed versioned catalog manifest with count, content hash, source revision and fetched/publication times. Operator fetchers own refresh; there is one writer per namespace. Preserve fourteen-day Cherkasy PDF cadence and existing durable fetch cooldowns. No extra crawl or Supabase write is authorized here.
2. Authenticate the old source identity using its actual valid session server-side, and authenticate the target VPS session separately. Client-supplied owner UUID is not identity. Android local addresses can be imported as user-provided preferences, not trusted operator or ownership evidence.
3. Issue a fifteen-minute single-use transfer envelope bound to both subjects, target origin, version and nonce. Server signature is verified with a pinned public key. Store a durable nonce receipt atomically with final writes; retries return the same receipt, conflicts409. Never put reusable session/device/QR secrets in exports or logs.
4. Preview exact canonical mappings, unresolved streets/houses/multiple lines, names, preferences, and address limit. Preserve unresolved addresses locally; do not substitute a neighbour's line. Import preserves user labels and literal house identifiers. Consent/notification permissions are freshly checked on each platform, not copied as an OS permission.
5. Existing sensor owner/viewer access is retained under its authenticated VPS subject. Linking identities requires proof of the existing VPS session or existing agreed owner/recovery flow. An address match, an export, or a bare sensor UUID never creates membership. Do not invent new account recovery; keep an export plus the existing owner QR rules until a separately accepted recoverable account flow exists.
6. Rehearse in an isolated DB, reconcile counts/mappings and verify rollback. Enable only for opted-in test clients, then a small cohort. Legacy API stays available, domain/DNS last. No automatic deletion of Supabase source records; after migration no bidirectional last-write-wins sync.

## Required client work (pending)

Android/PWA must retain a local backup before import, show the preview and obtain consent, store the returned stable IDs/idempotency receipt, and keep the old path until server success. Real authentication bridge, durable import endpoint and recoverable login must be implemented and tested before migration is enabled. `preview.js` is not an authentication provider or an enabled import API.

Acceptance: tampered/expired/wrong-target/wrong-subject envelopes rejected; duplicate nonce rejected; spoofed sensor ownership rejected; exact address mapping, unknown and multiline kept explicit; no database mutation by preview; no old clients moved.
