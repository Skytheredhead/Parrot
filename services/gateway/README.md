# Gateway foundation

This package is the narrow HTTPS boundary between clients and authoritative/derived services. It contains no real provider credentials or production adapters. `buildGateway(config, dependencies)` accepts reviewed adapters; the standalone entrypoint requires `GATEWAY_ADAPTER_MODULE` to export `createGatewayDependencies(config)`.

Security invariants enforced here:

- OIDC cryptography validates exact issuer/audience, an allowlisted access-token `typ`, bounded age/lifetime, and a same-origin bounded JWKS response. JWT privilege-shaped claims are discarded; an authoritative resolver maps issuer/subject to the current internal principal, kind, and authorization epoch.
- Exact-origin CORS is used. Cookie mutations require trusted `Origin`, unique `__Host-` cookies in production, equal CSRF cookie/header values, and a session-bound CSRF verifier. Exemptions are explicit route metadata.
- Distributed IP throttling uses the external rate adapter and trusts only configured proxy CIDRs.
  Separate interfaces require principal-global budgets before request-controlled workspace data and
  workspace budgets only after authorization.
- Invitation creation requires live workspace authorization, then generates a one-time response token
  with 256 bits of CSPRNG bearer material. Only a keyed SHA-256 digest, key ID, expiry, role/scope,
  optional normalized email binding, creator, use limit, and audit metadata cross the durable adapter
  boundary. Redemption is authenticated, requires a current verified human email, and delegates
  constant-time hash verification plus expiry/revocation/email/use-limit checks, membership creation,
  and audit creation to one atomic durable operation. Failure responses do not reveal which check
  failed. Tokens travel only in POST bodies; all responses are `no-store` and `no-referrer`.
- Current human principals can list only bounded, allowlisted metadata for their own active sessions,
  revoke one owned session, or revoke every other owned session. The durable authority atomically
  rechecks principal ownership and authorization epoch and writes audit metadata with each revocation.
  Revoke-others retains the exact current session and requires a cryptographically verified recent
  `auth_time` (or provider-equivalent assertion); access-token issuance time is never treated as
  reauthentication. Cookie clients use the normal Origin and session-bound CSRF boundary, and unknown,
  foreign, malformed, or already-revoked session IDs share one non-enumerating response.
- Database, file, search, agent stream, and tool requests require live authoritative authorization. Tool authorization includes the exact tool, and capabilities carry purpose, audience, authorization epoch, and one-use intent.
- Agent-tool idempotency scopes are namespaced by principal, authorization epoch, workspace, run,
  and tool. A separate canonical argument hash lets the durable adapter reject reuse of the same
  idempotency key with changed arguments instead of silently replaying or executing twice.
- Uploads use opaque single-write quarantine keys with mandatory SHA-256, size, and media-type constraints. Completion pins the observed object version. Clean downloads require immutable metadata and sign the exact scanned version/checksum. Unauthorized and unavailable file states are indistinguishable.
- Search candidates are workspace-filtered and individually reauthorized before titles/snippets are returned. Engine totals are never exposed. Cursors are authenticated and bound to principal, query, workspace, epoch, and expiry; per-field and total response budgets apply.
- Webhook signature verification is provider-pluggable. A verified event is handed to one atomic `enqueueOnce` receipt/outbox operation; external effects do not run in the HTTP request.
- Logs emit allowlisted error fields only. Authorization/session/CSRF/readiness/webhook/idempotency material and capability URLs are redacted. HTTP telemetry captures no headers and redacts credential-bearing query parameters.
- Detailed readiness requires an internal token, coalesces concurrent polls, aborts timed-out probes, and covers every security-critical adapter. Public liveness reports only process health.

Provider release gates:

- An object adapter must prove that its signed PUT binds checksum, exact size/type, and first-write-only behavior; its clean store must be immutable and support exact-version reads. It must safely encode `Content-Disposition` display names and set the approved download headers.
- Each webhook provider needs an implementation using its official canonicalization, rotation, timestamp, and signature rules plus official test vectors. `HmacSha256WebhookVerifier` is only a generic reference/test verifier.
- Session adapters must prove expiry, revocation, rotation, fixation resistance, secure cookie issuance, and server-bound CSRF state. Principal resolution must query current authoritative identity state.
- Search adapters must treat engine cursors as opaque derived state, honor supplied authorization scopes, cap upstream response sizes, and support deletion/permission reconciliation.
- Proxy CIDRs, identity/JWKS egress, telemetry destination, cursor/CSRF key management, and distributed rate-limit storage require deployment-specific review.
- Invitation HMAC keys must be loaded by the reviewed adapter composition from secret storage, retain
  old verification keys only for the maximum invitation lifetime, and never enter environment samples,
  logs, database rows, frontend bundles, or API responses. The invitation store must pass the atomic
  redemption and constant-time digest conformance suite before release.
- The session provider adapter must map provider sessions to stable opaque IDs, query only the current
  authoritative principal, atomically enforce ownership/epoch on revocation, propagate revocation to
  the provider, and prove current-session retention for revoke-others. Session-cookie and access-token
  verifiers must expose the provider's real authentication time when available; refresh or token issue
  time must not refresh that marker.

Invalid or unsafe environment configuration fails startup. Production requires HTTPS origins/identity endpoints, `__Host-` cookie names, and a 32-byte-or-longer readiness token.

Production composition rejects every adapter marked test-only. Durable adapters must also pass
provider-specific conformance tests before release. File capabilities and agent stream URLs are
restricted to explicit approved origins. Upload capabilities must bind content type, exact length,
checksum, and first-write-only headers; stream tickets must use the exact `wss:` run path and
bounded token/expiry.

Invitation routes and their deliberately generic error contract are documented in
[`docs/invitations-api.md`](docs/invitations-api.md).
Session administration routes and client integration requirements are documented in
[`docs/sessions-api.md`](docs/sessions-api.md).
