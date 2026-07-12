# Parrot gateway production adapter

`dist/production/parrot.js` is a fail-closed production composition. It currently provides:

- WorkOS-compatible OIDC access-token verification through the configured HTTPS issuer and JWKS;
- caller-attested SpacetimeDB principal resolution, current-epoch authorization, search scopes, and
  authoritative file reservation/completion through generated caller-scoped views and reducers;
- disk-backed, immutable object versions; and
- short-lived HMAC capabilities served only by exact `PUT` and `GET` data-plane routes;
- HMAC-bound search cursors; and
- a host-local SQLite fixed-window rate limiter for the single-node deployment.

It does not implement an OAuth callback, refresh endpoint, logout endpoint, or browser session.
Provider surfaces listed as `*:disabled` in readiness are deliberately unavailable and return a
fail-closed error if called. OIDC claims are not a substitute for Parrot membership state; every
enabled data operation is rechecked against current caller-scoped SpacetimeDB rows.

## Required runtime references

All paths below are container-mounted paths. Secret values must never be placed in environment
variables, compose files, command lines, or this repository.

```text
GATEWAY_ADAPTER_MODULE=/app/dist/production/parrot.js
FILE_CAPABILITY_PUBLIC_ORIGIN=https://parrotapi.skylarenns.com
FILE_CAPABILITY_ORIGINS=https://parrotapi.skylarenns.com
LOCAL_OBJECT_ROOT=/var/lib/parrot/gateway
FILE_CAPABILITY_HMAC_SECRET_FILE=/run/secrets/parrot_object_capability_hmac
SPACETIMEDB_URI=ws://spacetimedb:3000
SPACETIMEDB_DATABASE_NAME=project-conversation-production
GATEWAY_SQLITE_PATH=/var/lib/parrot/gateway/gateway.sqlite
```

The bearer-only composition does not read `WORKOS_API_KEY_FILE`. The WorkOS API key becomes usable
only when a reviewed operation requires it. Such an operation must open the mounted file at runtime,
bound its outbound request to the configured WorkOS origin, redact failures, and discard the value.

## Browser login contract (not yet implemented)

Do not expose a callback route until the durable session authority exists. A future integration must
use Authorization Code + PKCE (`S256`), one-time server-stored `state`, OIDC `nonce`, exact callback
URI matching, issuer/client binding, and `__Host-` Secure HttpOnly SameSite cookies. Refresh-token
rotation and logout must atomically revoke the authoritative session. Until then, clients may send a
short-lived WorkOS access token as `Authorization: Bearer ...`.

For AuthKit, configure the exact issuer, client-bound audience and JWKS URL issued by the WorkOS
dashboard. `OIDC_ALLOWED_TOKEN_TYPES` must list the protected-header `typ` values WorkOS actually
issues for this client; the verifier does not silently accept an absent or unexpected token type.

## Disabled provider surfaces

The following adapters are explicitly named `disabled-surface:*`, report that disabled state in the
readiness check name, and never fabricate a successful result:

- cookie sessions and CSRF;
- search provider queries;
- inbound webhooks;
- agent stream and gateway tool capabilities;
- invitation creation/redemption; and
- session administration.

The generated-binding connection uses the exact bearer retained in private exact-object provenance
after signature/issuer/audience/lifetime verification. It waits for subscription application,
checks the authenticated Spacetime identity against `current_gateway_principal`, and waits for
matching cache state after file reducers before reporting success. WorkOS-to-SpacetimeDB
interoperability still requires a live staging conformance test with the final issuer, audiences,
and token `typ` profile. `/v1/db-token` returns only the exact bearer the caller already supplied,
and only when that verified JWT also contains the configured DB audience, its expiry still exactly
matches the verified identity, and the current workspace grant/authorization epoch allows access.
The response reports the JWT's real expiry; Spacetime caller-scoped views remain the authorization
boundary.

## Object capability invariants

- Capability tokens bind operation, canonical key, immutable version, expiry, content type, exact
  length, SHA-256 digest, and single-write semantics.
- Uploads require `If-None-Match: *`, reject transfer/content encoding, stream to a bounded temporary
  file, and publish through non-overwriting filesystem operations.
- Browser clients must let `fetch` derive `Content-Length` from the exact `Blob`/body because browsers
  forbid JavaScript from setting that header manually; the gateway still checks the observed header
  against the signed length. All other returned required headers must be sent exactly.
- Downloads recheck the exact key/version/hash/type descriptor and stream the immutable version.
- The capability secret must contain at least 32 bytes. Rotate it by replacing the mounted secret and
  restarting the gateway; existing short-lived capabilities then stop working.
- The object root must be on a filesystem where hard links are atomic and must not be writable by
  unrelated host processes.
