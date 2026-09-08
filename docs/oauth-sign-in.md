# OAuth sign-in and shared reauthentication

This repository provides the backend API. It contains no client application or
sign-in page. A consuming client uses the capabilities and flows below. Deployment
configuration is in [the Coolify runbook](../reports/coolify-deployment.md#14-google-oauth-sign-in).

## Account policy

Administrators still create every account with a password. Google adds a sign-in
method to an existing account; it cannot register users, create credentials, or
replace administrator-managed names, images, roles, or contacts.

The first Google sign-in must prove a verified Google-authoritative address that
passes the existing local email schema. With the shipped Gmail, Outlook, Hotmail,
Live and Yahoo allowlist, ordinary eligible Google identities are verified Gmail
accounts. Third-party Google Accounts at the other four domains are rejected.
Custom Workspace domains remain rejected by the local allowlist, even with a
verified `hd` claim. Both policies must pass.

Email matching uses the existing trimming/lowercasing normalization. Dots, plus
suffixes and domain aliases are never rewritten. The first match atomically adds
one `google` account and marks the existing email verified. It sends no email OTP.
`REQUIRE_EMAIL_VERIFICATION` remains `false`; Google's verified transition also
works when that setting is enabled in a project derived from this starter.

Returning sign-ins resolve by provider and stable Google `sub`, then require the
current Google and local emails to match. Changed Google emails, conflicting
subjects, suspended/deleted users and ineligible roles receive a generic denial.
They cannot transfer, merge or relink accounts.

Local 2FA is evaluated on every login. Only the current signature-verified ID
token's string-array `amr` containing exactly `mfa` permits bypassing local 2FA.
Missing or malformed evidence uses the existing local challenge, including on a
trusted device. If an enabled account has no usable local factor, that login is
denied. When the global 2FA method list is empty, Google follows the same audited
feature-disabled downgrade as password sign-in, even if old enrollment remains.
No MFA assurance is saved on the Google link.

## Client sign-in contract

All paths are under the existing same-origin API and cookie policy. Use
`credentials: 'same-origin'`; preserve the server's `Set-Cookie` headers. Start
requests require the normal Origin/CSRF protections and the Turnstile token in
`x-captcha-response`. Never send local user IDs, Google profile fields or role
claims.

1. Fetch `GET /api/auth/capabilities`. Its body is
   `{ "success": true, "data": { "oauthProviders": ["google"] } }` when enabled,
   or an empty array when disabled. Render the Google button only when present.
2. Submit `POST /api/auth/oauth/google/start` with
   `{ "mode": "sign_in", "rememberMe": true, "callbackURL": "/auth/complete" }`.
   `mode` defaults to `sign_in`; `rememberMe` is optional and follows the existing
   sign-in default. `callbackURL` must resolve to `PUBLIC_ORIGIN`, without a hash
   or URL credentials. Choose a completion page owned by the consuming client.
3. Navigate the browser to `data.url` in the success response. The URL carries
   protocol state, nonce and the PKCE challenge; use it for navigation only and
   never log it. The browser must return with the state cookie in the same session.
4. Google returns to `GET /api/auth/oauth/google/callback`. The server exchanges
   the code and verifies the ID token. It redirects to the supplied completion
   page without adding codes, tokens, profile data or state to that page's URL.
5. On that page, fetch `GET /api/auth/oauth/result` once with cookies. The result
   expires after 60 seconds and is single-use. Interpret its body as follows:

| Body                                                | Client behavior                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "success": true, "data": { "loggedIn": true } }` | Refresh the current session, then enter the application.                                                                                           |
| Existing `twoFactorRedirect: true` challenge body   | Continue the existing [2FA flow](two-factor-flow.md), using its offered options and challenge cookie. No authenticated session has been delivered. |
| HTTP 401 failure envelope                           | Show a generic sign-in failure and offer a new attempt or another available method.                                                                |

Without `callbackURL`, the callback returns its JSON outcome directly. An invalid
or unbound callback receives a generic failure rather than an untrusted redirect.
Disabled Google paths return 404, including at the Better Auth handler boundary.
Generic library social sign-in/linking paths are not enabled.

The generated authenticated OpenAPI document includes these paths, bodies,
challenge branches, status codes, callback query and redirect contract.

## Reauthentication

Google is a sign-in method only. [Google documents](https://developers.google.com/identity/siwg/security-bundle)
that applications cannot request Google Account reauthentication. A new local
session or token timestamp does not prove fresh user authentication. The owner
approved password and passkey proofs for sensitive operations; clients must not
offer a Google reauthentication button or ask users to sign out of Google.

Fetch `GET /api/auth/reauth/methods` with an authenticated session. The response is
`{ "success": true, "data": { "methods": ["password", "passkey"] } }`
when both are usable. Offer every returned method and let the user choose.
An unenrolled or disabled method is omitted. The endpoint does not authorize an
action by itself.

| Method   | Proof                                                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password | Existing `POST /api/dash/auth/reauth` with `{ "password": "…" }`.                                                                                                                                                                                                                  |
| Passkey  | POST `{}` to `/api/auth/reauth/passkey/options`; run a WebAuthn authentication ceremony using `data`; POST `{ "response": <AuthenticationResponseJSON> }` to `/api/auth/reauth/passkey/verify`. User verification is required, and the ceremony is bound to this user and session. |

Successful password/passkey proofs return `data.expiresIn`. Each opens the same
15-minute window on the current session. No new local
session or password is created. Existing permissions and live-account checks
still apply to every protected operation.

During that window, clients may omit `currentPassword` on self-service password,
email and phone changes, or omit `password` on the existing 2FA management
operations. The passkey enrollment grant and TOTP URI path accept the same
window. Supplying a password still verifies that password; a wrong supplied
password is not overridden by the window. Existing password rules, compromised
password checks, OTP contact proofs and last-factor protections remain in force.

If no password is supplied and this session has no usable window, these paths
return HTTP 401 with `code: "REAUTH_REQUIRED"`, matching administrative actions.
Use that code to open the password/passkey prompt, then retry the action.

Passkey reauthentication requires a stored credential and globally enabled
passkeys. Method availability is rechecked when granting and consuming a window;
credential rotation revokes the window. Google sign-in never creates this window,
and `mode: "reauth"` is rejected by the Google start endpoint.

## Local email changes

Both administrator changes and completed self-service changes delete the Google
link in the email transaction and revoke all local sessions, including the current
session. Pending 2FA, trusted-device and reauthentication proofs are revoked.
An invalidation timestamp prevents an anonymous OAuth attempt begun before the
change from recreating a link afterward. Soft deletion removes all accounts.

After a self-service email commit (`data.verified: true`), show an alert that the
email changed and the user must sign in again, clear client session state, and
return to sign-in. Both email routes document this obligation in their OpenAPI
success response. An OTP-pending response (`data.verified: false`) leaves sessions
active. The password account remains available
at the new address. Existing password and phone-change session policies remain
as documented for those operations.

## Implementation and verification

`lib/auth/oauth.ts` is a narrow Better Auth plugin: it uses the installed library's
Google authorization URL, code exchange, state and ID-token verifier. Its
transaction bridges the existing Drizzle adapter and session hook so linking,
email verification and session admission agree before commit. General account
linking stays disabled. Google tokens and profiles are not persisted; the account
stores only provider, issuer, stable subject and local user association.

Proof start times and the revocation timestamp use the database clock, including
passkey ceremonies. This blocks an already-verified proof from reopening a window
after a password change that retains its session. Google callback failures emit
structured `oauth.signIn.failed` events with stage and controlled reason codes;
they omit tokens, provider payloads, email, subject and raw exception messages.
Identity-policy denials use the warning level; unexpected failures use the error
level. Other callback failures retain their error-level diagnostics.
The verifier collapses invalid tokens and JWKS failures into a null verdict, so
those share the token-verification stage. Link creation and removal are audited.

Retained OAuth tests cover the routed exchange with signed RSA tokens and a
controlled Google transport, real signed WebAuthn assertions, local OTP
completion, independent callback races, generic denials, configuration gates and
both email-change routes. The migration test runs the real deployment migrator
against clean and previous schemas. See the [implementation handoff](../reports/oauth-sign-in-implementation.md)
for exact final commands and deployment limitations.
