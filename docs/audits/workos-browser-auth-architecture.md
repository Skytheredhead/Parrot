# WorkOS browser authentication architecture — 2026-07-12

## Decision

Use the official `@workos-inc/authkit-react` client-only integration with Hosted AuthKit, PKCE,
and a **custom WorkOS Authentication API domain** under `skylarenns.com`. This can safely satisfy
Parrot's Vite SPA and bearer-only Fastify gateway without adding a BFF, provided production does
not use AuthKit React's `devMode`.

Recommended domain: `authapi.skylarenns.com`. This is the Authentication API domain supplied to
`AuthKitProvider` as `apiHostname`; it is not `parrotapi.skylarenns.com` and must not point to the
Parrot gateway. A separate branded Hosted AuthKit domain such as `auth.skylarenns.com` is optional.

WorkOS explicitly documents that AuthKit React is the client-only SPA integration, handles the
authorization redirect and session refresh, and exposes `getAccessToken`, `signIn`, and `signOut`.
With a custom authentication API domain, the refresh token can remain in a secure HTTP-only cookie.
Without one, the documented `devMode` fallback stores the refresh token in local storage. That
fallback is acceptable only for local/staging evaluation, not Parrot production.

If a WorkOS custom Authentication API domain is unavailable due environment, billing, or product
constraints, then a BFF callback/session layer is required for production. It must exchange the
code and rotate refresh tokens server-side, keep them in an encrypted server-side session or
`Secure; HttpOnly; SameSite=Lax` host-only cookie, and mint/proxy short-lived bearer calls. Do not
ship `devMode` local-storage refresh tokens as the workaround.

The currently supplied `sk_test_...` credential indicates a WorkOS staging environment. WorkOS
documents custom domains as production-only, so the preferred HTTP-only-cookie SPA architecture
cannot be completed with that staging environment alone. For the present one-user test, either:

1. unlock/configure a WorkOS production environment and use the custom Authentication API domain;
   or
2. add the BFF now and keep the staging refresh token server-side.

Using `devMode` may be tolerated only as an explicitly temporary staging experiment with no real
data. It must remain a launch blocker and must never be promoted unchanged to production.

## Exact production dashboard settings

For the WorkOS application with client ID `client_01KNAKHWDENJZH10KDPEYAMZMN`, in the correct
production environment:

| WorkOS setting | Value |
|---|---|
| Default redirect URI | `https://parrot.skylarenns.com/callback` |
| Sign-in endpoint | `https://parrot.skylarenns.com/login` |
| Sign-out redirect | `https://parrot.skylarenns.com/signed-out` |
| Allowed CORS web origin | `https://parrot.skylarenns.com` |
| App homepage URL, if separately requested | `https://parrot.skylarenns.com/` |
| Authentication API custom domain | `authapi.skylarenns.com` |

Use exact production URLs, no wildcard production redirect, and no Vercel preview origins in the
production WorkOS environment. Give previews a separate WorkOS staging application/environment.
Production web redirects require HTTPS. When WorkOS supplies the DNS target for the custom domain,
create that CNAME in Cloudflare as **DNS only**, not proxied; WorkOS documents that cross-account
Cloudflare proxying is unsupported.

The callback is a client-side route: Vercel must rewrite `/callback`, `/login`, and `/signed-out`
to the SPA entry document. `AuthKitProvider` processes the callback. The callback route must replace
history after completion so the authorization code is not retained in browser history, logs, or
later referrers.

## Browser and gateway flow

1. Wrap the SPA in `AuthKitProvider` using only the public client ID and
   `apiHostname="authapi.skylarenns.com"`. Do not set `devMode` in production.
2. `/login` calls `signIn()`; Hosted AuthKit performs authentication and redirects to
   `/callback` with an authorization code. AuthKit React completes its PKCE exchange.
3. Wait for AuthKit's loading state to settle. If authenticated, call `getAccessToken()` only when
   a gateway request or database-ticket renewal needs it. WorkOS documents that this returns the
   current token or refreshes it when necessary.
4. Supply that callback to `ProjectConversationClient`. It sends
   `Authorization: Bearer <access-token>` to `https://parrotapi.skylarenns.com`; bearer clients do
   not send Parrot CSRF cookies.
5. Call `/v1/db-token` for the selected workspace. Keep both WorkOS access tokens and short-lived
   SpacetimeDB tickets in memory. Never persist them in local storage, IndexedDB, URLs, telemetry,
   or error reports.
6. Connect to the approved public WSS subscription endpoint using the short-lived database ticket.
   On access-token expiry, `getAccessToken()` performs the AuthKit refresh. On database ticket
   expiry/reconnect, request a fresh ticket. On `401`, stop retries, clear caller-scoped state, and
   return to sign-in.
7. `signOut()` ends the WorkOS session and returns to `/signed-out`. After sign-out, discard the
   access token reference, database ticket, WebSocket, subscriptions, pending commands, and all
   workspace caches. Verify that the old access token/session no longer yields usable refreshed
   credentials and that revocation advances Parrot's authoritative access fence.

Refresh tokens are single-use/rotating according to WorkOS. The application must let AuthKit React
own refresh concurrency and replacement; custom code must not independently call the refresh grant.
Use a short WorkOS access-token duration consistent with the gateway's configured maximum token
age. The repository default gate is at most 900 seconds, so configure WorkOS access tokens to 15
minutes or less unless both sides are deliberately reviewed together.

## Public configuration versus secrets

Safe in Vercel `VITE_*` configuration and browser bundles:

- WorkOS client ID;
- `authapi.skylarenns.com` hostname;
- frontend and gateway public origins;
- public WSS origin and public SpacetimeDB database name, if required by the generated client.

Server-only secrets, never exposed to Vercel client code or `VITE_*` variables:

- WorkOS API key (`sk_*`);
- any WorkOS M2M client secret;
- webhook signing secrets;
- object-capability HMAC, readiness, database-owner, session-sealing, or cookie-encryption keys;
- Gmail/Ollama/provider credentials and all refresh tokens outside AuthKit's managed HTTP-only
  cookie.

The user supplied WorkOS API key is already disclosed in chat history and should be rotated before
broad launch even though the user allowed temporary use. The SPA integration does not need it.

## Gateway verification profile

WorkOS access tokens use `sub`, `sid`, `iat`, `exp`, and an application `client_id`; official docs
show that an `aud` claim may be absent. For this repository's verifier, production should therefore
be confirmed with a real token and generally use:

- `OIDC_AUDIENCE=client_01KNAKHWDENJZH10KDPEYAMZMN`;
- `OIDC_ALLOW_CLIENT_ID_AUDIENCE=true`;
- `OIDC_ALLOW_MISSING_TYP=true` only after confirming WorkOS omits JOSE `typ` for the real token;
- exact WorkOS issuer from the real token;
- exact WorkOS JWKS URL for the client ID.

The current gateway additionally requires issuer and JWKS to share an origin. With the default
WorkOS Authentication API this is normally the `api.workos.com` origin and JWKS path
`/sso/jwks/<client-id>`. If the custom Authentication API domain changes the token issuer, use that
same custom origin for authentication and JWKS, then validate a real token before traffic. Do not
guess the trailing slash or issuer value: decode one staging token for inspection, fetch JWKS, and
run the gateway verifier acceptance test without logging the token.

Do not authorize from WorkOS `role` or `permissions` claims. The existing gateway correctly uses
the verified external identity to resolve Parrot's current principal and authorization epoch.

## Revocation responsibilities

- Normal logout: AuthKit React `signOut()`, followed by immediate local teardown.
- Parrot “revoke this/other session”: the gateway must reach its session routes and use the server-
  side WorkOS API key to revoke the bound WorkOS `sid`; merely updating a Parrot table is not enough.
- Admin/provider revocation: consume verified WorkOS events or re-check session authority so the
  Parrot authorization epoch disconnects active database clients promptly.
- The live edge currently returns nginx 404 for every Parrot invitation/session route tested. That
  edge deployment must be reconciled before session management can be accepted.

## Required tests

1. Fresh profile sign-in, callback cleanup, authenticated gateway request, DB ticket, WSS connect.
2. Automatic access-token refresh with a deliberately short token lifetime; one rotated refresh,
   no token in local storage or application logs.
3. Page reload restores AuthKit session through the HTTP-only cookie and obtains a new in-memory
   access token.
4. Logout closes WSS and makes subsequent refresh fail; Back cannot resurrect the session.
5. Revoke another browser session and demonstrate its API request plus WSS reconnect fail.
6. Reject wrong client ID, issuer, expired token, excessive lifetime, forged role, and missing/extra
   JOSE `typ` according to the selected verified WorkOS profile.
7. CORS rejects all origins except the exact frontend; callback/login routes work on direct load.

## Official sources

- [WorkOS AuthKit React SPA guide](https://workos.com/docs/authkit/react)
- [WorkOS session and refresh-token guidance](https://workos.com/docs/authkit/sessions)
- [WorkOS session-token/JWKS reference](https://workos.com/docs/reference/authkit/session-tokens)
- [WorkOS logout reference](https://workos.com/docs/reference/authkit/logout)
- [WorkOS redirect requirements](https://workos.com/docs/reference/authkit/authentication/get-authorization-url)
- [WorkOS Authentication API custom domain](https://workos.com/docs/custom-domains/auth-api)
- [WorkOS environment separation](https://workos.com/docs/authkit/environments)
