# Billing and rights

Google Play purchases are verified only by server Developer API calls. A raw
purchase token, client flag, order ID, screenshot or RTDN type grants no rights.
The recoverable account is bound by the server's HMAC obfuscatedAccountId;
tokens are unique, encrypted with a dedicated AES-GCM key and excluded from
logs, metrics, browser storage, public responses and domain event payloads.

Registration and reconciliation events share a transaction. The worker has a
per-purchase fenced lease and always fetches current provider state. Grant,
replacement invalidation, feature revision and outbox events commit together.
The acknowledgement has a separate durable job after the grant; a lost ACK
queries provider acknowledgement state before retrying. Pending replacements
retain the old grant; completed replacements cannot reactivate the old token.
Periodic reconciliation runs every15min in bounded batches. Refund/voided RTDN
also triggers a current-state lookup. No financial refund API is invoked.

`svitlo_entitlements` owns fixed rights: free2/premium10 canonical homes,
32confirmed lines per home and1sensor per line. It supports multiple providers
and audited temporary manual grants without editing sensor ACL or history.
Existing private grants remain compatible. Cancellation retains a still-valid
period; grace retains access; hold/pause/expired/pending grant no premium.
Failed verification never renews an entitlement. Unexpired rights without a
successful check for24h become unknown; the sensor gate returns503 rather than
inventing a confirmed expiration. Downgrade does not delete homes/history or
silently choose which homes to keep.

RTDN requires Google's signed service-account identity, exact audience and
subscription name. The durable inbox deduplicates before responding; delayed
events cannot overwrite newer status. Unknown tokens have a hash-only receipt
and are reconciled after authenticated registration. This webhook needs a
dedicated authenticated machine ingress, separate from browser challenges.

`POST /api/v1/billing`: `status`, `checkout`, `verify`. Requires main session and
CSRF. `checkout` returns public product IDs and the current account's obfuscated
ID; displayed prices must come from Google ProductDetails. No price is hardcoded.
`POST /api/integrations/google-play/rtdn` uses Google bearer proof, not a session.

No Google project/products/credentials exist yet. Default mode is disabled and
`accepting=false`. Separate `license` and `live` modes distinguish test receipts
from money. The worker cannot change mode or accepting; stopping new checkout
does not stop reconciliation. Mount `/run/billing/purchase-key` in API+worker,
and `/run/billing/google-service-account.json` only in worker. Configure package,
products, RTDN audience/email/subscription explicitly. Escrow/restore the
encryption key before enabling payments. Real refund variants, licensed test
purchase/renewal/restore and production acceptance remain external gates.
