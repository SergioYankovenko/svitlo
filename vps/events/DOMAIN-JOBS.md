# Versioned module jobs

SQL1028 adds a module outbox alongside the catalogue compatibility queue.
Module owners publish a whitelisted event in the same transaction as their
domain write. An aggregate revision is immutable. Each consumer has its own
unique event receipt, bounded lease, attempts, deadline and quarantine state.
The worker cannot publish or replay domain events; API roles cannot read them.

`DomainJobs.database` locks a current lease and commits its database effect
with the receipt. A failed or expired acknowledgement rolls both back.
`DomainJobs.external` sends outside a transaction and supplies a stable
`eventId:consumer` key. The provider or recipient must suppress duplicates;
a server crash between HTTP and ACK can repeat delivery. Provider acceptance
is not proof of device receipt.

Only the administrative command facade receives `replay_delivery` permission.
A replay requires an actor, unique request ID and reason. It cannot replay a
completed or expired job and is limited to five recovery cycles. Reusing a
request ID with different input is rejected. Receipts retain 91 days; module
purchase/measurement ledgers must independently preserve domain idempotency.

Older consumers request schema1 explicitly and leave unsupported versions for
a compatible consumer. No payload selects a URL, SQL statement or executable
handler. Credentials and provider purchase tokens belong in protected module
storage and are absent from job payloads.
