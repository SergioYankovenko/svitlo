# Private VPS runtime, Plan228

> Plan229 adds the working private universal v1 API and staging PWA integration: [contract and onboarding](universal/CONTRACT.md), JSON Schema and golden vectors in the same directory. Backend contract/PG/HTTP checks pass; full new-shell browser save/reload/offline QA remains pending. Android and production routes are unchanged. The Plan228 description below is historical baseline infrastructure, not the current universal implementation status.

This is an isolated first working port of the existing Cherkasy PWA. It is not the complete universal BE-08 or a production cutover. No browser Supabase Auth/SDK calls, no copied production users, no live push credentials. The current branch preserves the existing production transport when `config.transport` is not `vps`; the staging build always writes its own config.

Runtime: Node24, pinned base image, PostgreSQL17, own HttpOnly anonymous sessions and owner RLS. `PgBridge` is a server-only compatibility layer for the existing Database class, not an exposed generic SQL/RPC endpoint. Transactions use one checked-out connection and `SET LOCAL` owner context, released in finally. Owner/CSRF metadata stored in browser storage is only an offline cache selector; an opaque cookie must authenticate every server operation.

## Private API surface v1

| Route | Method | Behavior |
|---|---|---|
| `/healthz` | GET | Process liveness, staging scope and release |
| `/readyz` | GET | DB/schema/delivery-mode readiness; productionReady=false |
| `/api/session` | GET | Existing unexpired session metadata or null; no silent creation |
| `/api/session` | POST | Anonymous cookie session; strict same origin + JSON, bounded creation |
| `/api/session` | DELETE | Revoke cookie hash; CSRF for an existing session |
| `/api/v1/capabilities` | GET | Cherkasy adapter, catalog scope, unsupported sensors/push |
| `/api/v1/catalog` | POST | PostgreSQL dictionary: kind=department/city/street/house, optional parent; cookie+CSRF |
| `/api` | POST | Existing profile actions through Service.handle; cookie+CSRF |

`/api` retains dictionary, preview, confirmed save, bootstrap/sync, refresh, weather, preferences, delete/erase, resolve_queue. Max10 profiles and address dedup/revision rules are inherited unchanged. Subscribe is explicitly rejected in staging. No arbitrary table/function/SQL access. Existing status/freshness/partial/category semantics remain the business contract; a numeric queue is not proof of physical power. Public catalog exclusions retain `status:not_found,inclusion:not_in_queue`, distinct from a catalog miss. Provider account values are transient inside PrivateSource, never persisted in profile/catalog or returned to the browser.

Errors are JSON/no-store:400invalidinput,401nosession,403Origin/CSRF,404notfound,409disabledpush,421wrongHost,429rate,503temporarilyunavailable. JSON body max16KiB. Host is `localhost:18765`, secure browser context via loopback, encrypted SSH network hop. This is not an internet HTTP deployment. For future HTTPS use Secure cookies and reviewed origins/proxy policy before exposing it.

The preview quota uses the immediate socket peer, shared behind its private proxy. Before a public deployment, implement and test trusted-proxy client-IP handling and public session-abuse limits; never trust arbitrary forwarded headers. These private limits are not a production capacity configuration.

## Schema and scheduling

`migrate.mjs` locks migration execution, records names/hashes and rejects changed applied SQL. The original Supabase migrations are reused with a plain-PG auth/role shim. The conditional maintenance migration is cut **before** `svitlo_internal.dispatch()`: production cron/net/Vault HTTP dispatch is intentionally excluded. Migration-only owner credentials are mounted only for the admin command. Runtime API cannot bypass RLS; the worker is a separate restricted LOGIN/BYPASSRLS role for this staging database.

`worker.mjs` runs once a minute, awaits all phases, uses DB claims, and performs bounded maintenance. Worker-only due selection includes staging profiles with no push subscription; it never enables push. `registry.mjs` runs from a systemd hourly timer, holds its own DB advisory lock and respects the imported 14-day nextCheckAt. Server/provider cooldowns and Retry-After are retained, no bypass or full address census. Registry changes are staging-only and still use existing safety/hold/reconciliation policy.

Persistent PG volume, secrets, local backup/restore and root-only health are documented in the workspace [operational package](../../README.md). Two API slots share sessions/data, Nginx switches only after readiness, and the previous immutable image remains for rollback. Schema1 changes here are compatible across tested slots; arbitrary future destructive migration cannot be rolled back by switching a container. TLS/offsite backups/owner alerts/CI/phone QA and full normalized address API remain production gates.

## Local checks and build

```powershell
npm ci
node --test tests/*.test.mjs vps/session.test.mjs
node vps/build.mjs
```

Existing catalog SQL tests additionally require the public fixture `../work/prod-address-rollout-20261026/schema.sql` relative to this checkout. This workspace supplies that copy; absence is a test environment failure. Do not change expectations to hide it.

Build writes only `dist/app`; no modifications to production app/config/sw source. It excludes the browser SDK, replaces config, labels staging, hashes the complete shell and uses the separate `svitlo-stage-*` cache namespace. Tests against the actual VPS are `integration.mjs` (API/session mounts), `worker-test.mjs` (worker mounts; requires only the named disposable QA profile), and the workspace HTTP/load/continuity scripts. These are not automatic production tests and do not send notifications.

The reviewed artifact includes package lock, app/server/vps/migrations and the existing public seed bundle. VPS deployment scripts stay in the workspace operational package; they depend on its pinned SSH/DPAPI bootstrap helper and never put credentials in Git or command arguments. No push to main or release is part of this change.
