# Optional Alerts Energy adapter

Reviewed the documented OpenAPI and authentication pages on2026-11-07:
https://alerts.energy/api/v1/openapi and
https://alerts.energy/developers/api/authentication.
Use only the licensed public API with a server bearer key. No website scraping,
account creation, subscription purchase or automatic source switching occurs.

Shared durable quota:5requests/s,10,000/day, Kyiv-midnight reset, Retry-After
cooldown. Full area snapshots and statuses are cached10min; the50-entry changes
log never substitutes for a complete resync. Fixed URLs, bounded JSON and no
secret URLs/logs. Missing key/configuration performs no network request.

The adapter is registered but cannot activate until a server key, explicit
quota flag, operator selection and reviewed exact canonical mappings exist.
Mappings retain operator identity, source reference, completeness and validity.
The auxiliary API cannot allocate an address, silently choose a same-name
house, upgrade an incomplete binding, or overwrite official IDs. Fallback from
an official source is an explicit reviewed policy, never a transport-error
shortcut. Adapter timestamps preserve publication time; unknown publication
time remains null/stale. Hour cells0/1/2/3 retain half hours. Possible intervals
remain separate. Emergency, absent/invalid hours and ambiguous DST days do not
produce a confirmed availability window.

Local vectors exercise documented shapes; real Cherkasy/Kyiv/region comparisons
and license/quota recovery require the user's future API credentials. They
remain pending. This adapter is optional and does not gate the core release.
