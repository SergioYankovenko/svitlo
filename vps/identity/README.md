# Recoverable identity

The existing `auth.users.id` remains the account ID. Google issuer+subject has a
unique account binding. Email, installation ID and address matches grant no
access. Google ID tokens are verified with `jose` against the fixed Google JWKS,
issuer, configured server audience, authorized Android party, expiry, issued-at
and one-use session-bound nonce. Tokens and email are not persisted or logged.

`POST /api/v1/identity` is session+CSRF protected. `status` works without Google
configuration. `challenge` (`mode:sign_in|link`) returns a five-minute nonce and
serverClientId. `complete` accepts that nonce and `idToken`. Linking a new Google
subject keeps the current UUID. Recovering an existing subject rotates the
session and returns that account. Guest assets or another recoverable account
require explicit `confirm_switch` with a one-use five-minute review token.
This switches accounts; it never merges profiles, subscriptions, device
memberships, sensor epochs or history. `link` refuses a subject owned elsewhere.

Credentials are not available yet. Set `GOOGLE_WEB_CLIENT_IDS` and the allowed
`GOOGLE_ANDROID_CLIENT_IDS` only after Cloud project/Android configuration is
ready. Capabilities advertise `google:false` meanwhile; challenge/complete
return `identity_not_configured`. Local RSA vectors and SQL state transitions
do not replace a real Android Credential Manager/web Google acceptance test.
