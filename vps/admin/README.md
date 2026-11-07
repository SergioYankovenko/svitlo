# Administration

Separate process, origin, pool (2 connections), database role and cookie.
React-admin is a separate static build and does not implement authorization.
Every resource and command is authorized again in PostgreSQL using the current
principal roles and unexpired session. Reader sessions cannot log into admin.

Until SSO is configured, SSH possession issues a five-minute, single-use login
ticket to a protected handoff file with `bootstrap.mjs`. Paste it in the login
username field. Password is unused. Login creates a thirty-minute session.
No ticket in a URL, browser storage, logs, source tree or report. Existing
principal roles do not change when issuing another ticket. Owner credentials
are mounted only in the SSH bootstrap/migration command, never this service.

The service exposes metadata-only lists and explicit commands, with CSRF,
same-origin/Host checks, bounded admission, reasons, expirations, durable
idempotency and audit. No generic CRUD or SQL endpoint. Source pauses hold
interactive fetches and background claims. Account blocks revoke sessions;
device blocks reject ingestion before any ACK/measurement mutation. Blocks
expire within 24h and do not transfer ownership or destroy device history.

The initial transport is an SSH tunnel to loopback port18768. Before a public
admin origin is enabled, configure independent TLS/SSO or equivalent protected
ingress; the module refuses non-HTTPS non-loopback origins. No public DNS is
changed by this package. Payment grants and mapping changes must be registered
as subject-specific commands after their owning modules are installed.
