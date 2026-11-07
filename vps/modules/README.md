# Module boundaries

`ports.js` is executed at composition, not a parallel mock architecture.
The existing catalogue, schedule reader and profiles service implement the
HTTP-facing ports; their stored UUIDs, DTOv1 and legacy wire remain intact.
Identity, billing, jobs, notification, object storage and charging adapters
are checked against the same fixed method definitions when installed.
An unconfigured external provider must return an explicit error/capability;
it cannot claim a successful empty result.

`requests.schema.json` is the source for live Ajv validation and OpenAPI3.1.
Domain validation still checks parent ownership, exact house/line identity,
date windows, revisions, ACL, quotas and source freshness. Structure alone is
not proof. Existing clients may omit schemaVersion on old v1 reader calls;
new identity packets require it. Snapshot/resolution source outputs continue
using the Ajv schemas in `vps/universal/` and existing semantic golden vectors.

Writer ownership remains: source evidence → sources; public address identity/
aliases → catalogue allocator; index generations → search worker; profiles →
authenticated profile functions; Google subjects/sessions → identity; verified
purchase evidence → billing; feature grants → entitlements; sensor ACL/epochs/
measurements → sensors; intents/attempts → notifications; command/audit → admin.
Ports do not authorize cross-module table writes. New tables/functions use
private owner roles with only reviewed command functions granted to runtime.

The module state vocabulary distinguishes blocked/captcha/quota/rate-limited,
unsupported, stale, degraded and unknown. No adapter can turn these states
into a confirmed all-day power window or a measured supply state.
