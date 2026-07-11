# ADR 0002: Authentication, authorization, and security architecture

- **Status:** Proposed; identity provider selection and the exact SpacetimeDB 2.6.1 token/View preflight require proof
- **Date:** 2026-07-11
- **Scope:** Human/service authentication, tenant authorization, invitation/session lifecycle, secrets, and security controls

## Context

The system must support secure registration, email verification, recovery, optional social login, expiring/revocable invitations, session revocation, private spaces, guests, agents, services, and immediate cross-tenant protection. SpacetimeDB authenticates OIDC identities, but a valid token alone does not establish application membership or permission.

## Decision

### Identity provider and session model

Use a production OIDC provider rather than implementing passwords in the Rust module. The provider must support:

- verified email, recovery, brute-force protection, MFA-ready policy, and optional OAuth/social connections;
- Authorization Code + PKCE for browser flows;
- server-managed, `Secure`, `HttpOnly`, `SameSite` sessions and refresh-token rotation/revocation;
- short-lived tokens with explicit issuer and audience;
- client credentials or workload identity for services;
- session and user revocation webhooks or an equivalent reconciliation API.

The final provider is intentionally undecided. Selection must be based on these requirements and operating cost, not embedded into domain logic.

The Next.js/gateway session tier retains refresh capability; browser JavaScript never stores refresh tokens or non-expiring SpacetimeDB host tokens. It receives only a short-lived, database-audience token when opening WSS. If the browser SDK requires the documented `/v1/identity/websocket-token` exchange, only that tested path is exposed through the narrow proxy, and the long-lived token is never replaced with the returned short-lived WebSocket token.

Connections without a valid JWT are rejected in `client_connected`. The module verifies token presence, issuer, audience, and required claims using `sender_auth().jwt()`. OIDC `sub` plus issuer maps to one stable internal user identity; mutable email is profile data, not the authorization key.

### Authorization model

Authorization combines role and resource scope, with deny as the default:

- workspace roles: `owner`, `admin`, `member`, `guest`;
- nonhuman principals: `agent` installations and registered `service` identities;
- workspace membership plus optional explicit private-space membership;
- per-agent/service operation and resource scopes;
- resource state, such as archived, deleted, quarantined, or pending scan;
- current session, membership, installation, and authorization epochs.

A central Rust policy layer evaluates `can(principal, action, resource)` from indexed authoritative rows. Every reducer calls it after loading the target resource and derives the actor from `ctx.sender`; clients cannot select an actor type or impersonate a human, agent, service, administrator, or system principal. All tenant-owned identifiers are resolved to their stored workspace before authorization, preventing confused-deputy and cross-tenant ID attacks.

For reads, sensitive base tables remain private. Caller-aware Views use `ViewContext.sender` to join or filter through current membership and expose only required columns. They remove rows when permissions change. Anonymous Views are limited to caller-independent public content. Views complement but do not replace reducer checks.

Experimental RLS is prohibited. If required Views prove insufficient during the 2.6.1 preflight, the authorized gateway performs reads using the same policy contract; sensitive tables are not made public as a workaround.

### Session and permission revocation

OIDC token validation at connection time does not by itself guarantee immediate invalidation of an already-open socket. Therefore revocation is layered:

1. Revoke the provider session/credential.
2. Mark the application session or principal disabled and increment its `authz_epoch`.
3. Remove or disable relevant workspace/space membership or agent/service scope.
4. Every privileged reducer and worker completion verifies the current epoch; stale calls fail.
5. Caller-aware Views recalculate and remove inaccessible rows from the client cache.
6. The client subscribes to its minimal session/access state, clears private cache, cancels pending commands, disconnects, and requires reauthentication when revoked.
7. Short token lifetimes bound any gap if notification or socket closure fails.

Changing role, removing a private-space membership, disabling an agent, rotating a service credential, and signing out everywhere use the same epoch mechanism. Workers also watch the epoch and reauthorize immediately before context reads, tool calls, external effects, and final writes.

### Invitations

Invitation creation is an authorized reducer operation. The gateway generates at least 128 bits of random token material and stores only a keyed hash plus workspace, intended role/scope, optional normalized email binding, creator, expiry, use limit, and revocation state. Redemption requires an authenticated, verified identity, constant-time token comparison, and an atomic reducer that rechecks expiry, revocation, email binding, membership policy, and use count. Acceptance and membership creation share one transaction and audit entry.

Invite links are excluded from logs/referrers where possible, single-use by default, rate-limited, and never disclose whether an unrelated account exists.

### Security controls

- **Cross-tenant isolation:** workspace ID is derived from the target row; policy tests enumerate all role/resource/action pairs and adversarial foreign IDs.
- **Search:** indexing and query services receive scoped service identities. Results, snippets, previews, and counts are reauthorized against current authoritative permissions before return.
- **Files:** object keys are opaque. Uploads remain quarantined until size/type/malware checks pass. Signed URLs are short-lived, audience/purpose bound where supported, and issued only after live authorization. Downloads use safe content disposition and MIME handling.
- **Web:** use CSP, safe output encoding, sanitized rich text, CSRF protection on cookie-authenticated mutations, origin checks, secure cookies, clickjacking protection, and dependency scanning. Untrusted links/previews are fetched by a restricted service, never by privileged internal networks.
- **Reducers and sockets:** schema and size validation, per-principal/workspace rate limits, connection quotas, query/subscription limits, bounded pagination, and denial-safe errors.
- **Secrets:** provider keys and service credentials live in a secret manager, are never stored in client-visible rows or prompts, and rotate independently. Logs and traces redact tokens, invite material, signed URLs, and message content by default.
- **Audit:** privileged actions append actor, effective principal, tenant, action, target, outcome, request ID, policy version, and before/after references in the same transaction. An idempotent outbox mirrors audit records to restricted append-only storage; this is defense in depth, not a claim that the database owner cannot alter data.
- **Deletion and retention:** tombstone/retention transitions are authoritative. Outbox jobs delete derived search/object/provider data, and reconciliation proves propagation. Legal/operational retention rules are explicit and tenant-visible.
- **Abuse resistance:** authentication, invites, search, uploads, notifications, reducers, agent runs, and external effects have actor/workspace/IP-aware limits and cost budgets.

### Service authentication

Each gateway/worker workload has a distinct OIDC service identity, not a shared superuser token. Registration records bind issuer/subject to allowed service type and scopes. Reducers require both valid OIDC authentication and a current service registration, then validate the referenced job/run lease and tenant scope. Service calls cannot directly author human content.

## Assumptions and unresolved choices

- The chosen provider can mint a token whose issuer/audience the dedicated 2.6.1 host accepts, or a narrowly scoped token broker can do so without exposing refresh credentials.
- The exact 2.6.1 deployment supports the required caller-aware View semantics. This must be proven before direct client subscriptions.
- Immediate physical socket termination may not be available through the module. Security therefore depends on data removal, reducer/worker denial, client disconnect, and short token TTL; proxy-level forced closure can be added only after a supported connection mapping is proven.
- Detailed workspace role permissions and retention periods require product policy, but the enforcement mechanism does not.

## Alternatives rejected

- **Passwords in SpacetimeDB:** official guidance recommends external OIDC; doing this safely would recreate an identity platform.
- **Trust JWT role claims as tenant authority:** roles and memberships change independently and must be transactionally current.
- **Store long-lived tokens in `localStorage`:** XSS would turn them into durable bearer credentials.
- **Client-side authorization or public tables:** clients are untrusted and subscriptions can expose data before UI filtering.
- **RLS as the primary control:** officially experimental/unstable; Views are preferred.
- **One broad worker credential:** a compromise would cross tenants and capabilities.

## Required verification

Tests must cover invalid/missing issuer and audience, anonymous connection, expired token, recovery and global sign-out, invite expiry/replay/revocation/email binding, every role/action pair, guessed foreign IDs, private-space removal, workspace removal, role downgrade, service disablement, authorization epoch change during an operation, search count/snippet leakage, upload/download races, signed URL expiry, reducer abuse limits, XSS/CSRF protections, audit completeness, and deletion propagation.

The host compatibility spike must demonstrate that a membership change removes View rows and that a stale authenticated socket cannot successfully mutate after its application epoch changes.

## Current official evidence

Accessed 2026-07-11:

- [Authentication and OIDC](https://spacetimedb.com/docs/core-concepts/authentication/)
- [Using OIDC claims in a module](https://spacetimedb.com/docs/core-concepts/authentication/usage/)
- [Authentication FAQ and production provider guidance](https://spacetimedb.com/docs/intro/faq/)
- [HTTP authorization surface](https://spacetimedb.com/docs/http/authorization/)
- [Views and `ViewContext.sender`](https://spacetimedb.com/docs/functions/views)
- [RLS: experimental status and View recommendation](https://spacetimedb.com/docs/how-to/rls)
- [Self-hosting and public-route restrictions](https://spacetimedb.com/docs/how-to/deploy/self-hosting)
