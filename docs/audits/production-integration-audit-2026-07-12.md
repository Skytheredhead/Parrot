# Production integration audit — 2026-07-12

Scope: independent, read-only review of the repository and live production surfaces. This is a
launch-gap report, not an implementation claim. Checks were run from an external client against
`parrot.skylarenns.com` and `parrotapi.skylarenns.com` on 2026-07-12.

## Executive verdict

The backend domain has a partially working gateway deployment, and the frontend has a healthy
Vercel deployment, but Parrot is not yet an end-to-end product. The deployed frontend is an
unauthenticated deterministic prototype. It imports neither the gateway SDK nor generated database
bindings, persists nothing, and displays canned collaboration and agent data. The production edge
also exposes only part of the gateway route surface required for onboarding and session management.

Do not invite a test user until one automated end-to-end test proves the launch workflow below
against production or a production-equivalent staging environment.

## Minimum launch workflow to prove

One test user, in a fresh browser profile, must be able to complete this sequence with only public
surfaces:

1. Sign in through WorkOS, return to the exact approved frontend origin, obtain a usable principal,
   and sign out/revoke the session. A second browser must demonstrate revocation.
2. Bootstrap the first owner exactly once, create or select a workspace, reconnect, and still see it.
3. Create a space and a post using a stable command ID; observe the authoritative command receipt
   and the post through caller-scoped subscriptions.
4. Open a named thread and add a contribution; verify ordered real-time appearance in the second
   browser, disconnect it, mutate in the first browser, then prove catch-up after reconnection.
5. Upload a small file with the checksum-bound capability; prove quarantined state, clean scan,
   immutable authorized download, and rejection for an unauthorized user.
6. Search for the post/file after indexing; prove correct result, pagination, permission filtering,
   and disappearance after revocation or deletion.
7. Trigger a direct notification via mention or reply; prove unread state, preference enforcement,
   one browser sound after a user gesture, no duplicate sound after reconnect, and successful
   read acknowledgement.

The test must retain request/command IDs and timestamps, but no bearer tokens or capabilities. A
green unit suite is useful substrate; it is not a substitute for this cross-system proof.

## Blockers, ordered by launch impact

### P0 — frontend has no production integration

- `apps/web` describes itself as deterministic local state and has no dependency on
  `@project-conversation/client-sdk` or `@project-conversation/db-bindings`.
- There is no login/callback/logout/onboarding flow, no access-token or CSRF handling, no database
  ticket minting, no SpacetimeDB connection, and no caller-aware subscription lifecycle.
- Creating a post, approving an agent action, reacting, completing a task, selecting a space, and
  searching mutate/filter only component memory. Refresh loses all changes.
- There are no explicit connecting, reconnecting, offline, permission-revoked, command-pending,
  command-failed, empty-workspace, or fatal-error states.

### P0 — production edge route set is inconsistent with the repository

External probes produced:

- `POST /v1/db-token` and `POST /v1/search`: gateway JSON `401 unauthorized`, with exact-origin
  CORS and security headers. This proves those requests reach Fastify.
- `OPTIONS /v1/search`: `204`, correct `Access-Control-Allow-Origin` for the frontend.
- `POST /v1/invitations`, `POST /v1/invitations/redeem`, every sessions route tested, `GET /health/live`, and
  `GET /health/ready`: nginx HTML `404`, with no gateway request ID.

The checked-in `infra/nginx/edge.conf.template` includes sessions, invitations, and health in its
route expression, so the live edge appears stale or differently configured. Health may be
intentionally private, but session listing/revocation and invitation redemption are public product
contracts and must reach the gateway. Re-deploy the reviewed edge configuration, then test every
route/method pair rather than merely the hostname.

### P0 — there is no proven browser authentication/session creation contract

The gateway validates bearer/cookie credentials and administers existing sessions, but its public
route list contains no login initiation, OIDC callback, token exchange, or session-cookie creation
route. If the frontend will use WorkOS AuthKit and bearer tokens directly, document and implement
that exact browser flow, including logout/revocation and refresh. If it will use server-managed
cookies, the missing callback/session issuance boundary must be implemented. Never put the WorkOS
API secret in Vercel or browser code.

### P1 — product breadth is mostly absent from the UI

- New user/admin: no real onboarding, workspace creation, member/invitation management, roles,
  private spaces, sessions, audit, retention, export, or deletion UI.
- Heavy Discord/Slack user: no real unread model, inbox/activity view, keyboard navigation,
  message/post permalinks, durable drafts, pagination/virtualization, DM UI, or multi-workspace state.
- Agent developer/operator: only a canned approval modal exists; no installation, scopes, tool
  policies, run/event stream, cancellation, retries, budgets, provenance, or exact approval binding.
- Files/search: file tiles and search filtering are local decoration; no upload lifecycle, scan
  state, permission-safe results, cursor pagination, or failure UX.

### P1 — accessibility is not acceptance-tested

Positive foundations include semantic buttons, visible focus rules, labels on icon buttons, and a
reduced-motion media query. Remaining blockers include no automated axe/browser suite, no screen
reader proof, and dialogs without a focus trap, Escape handling, inert background, or focus return.
Mobile bottom-navigation buttons other than Create have no action. Toasts disappear quickly and
there is no tested high-contrast/zoom/reflow behavior. Complete keyboard-only and 200% zoom checks
before an accessibility claim.

### P1 — operations/recovery evidence is below the requested target

The requirements matrix itself still marks browser recovery, staging fault injection, durable
provider adapters, real deployed restore, monitoring targets, and measured RPO/RTO as incomplete.
The accepted objective is at most one hour of data loss and four hours to recover, backed up to
`/mnt/bigboi`; only a timed restore drill of the deployed composition can prove that objective.

### P2 — production polish and web hardening

- The live HTML title and package identity still say “Project Conversation” rather than “Parrot.”
- The frontend response has HSTS, but no CSP, Referrer-Policy, Permissions-Policy,
  X-Content-Type-Options, or clickjacking defense was observed. Add an appropriate Vercel header
  policy after inventorying required origins.
- The frontend sends `Access-Control-Allow-Origin: *` on static assets/pages. This is not itself a
  data leak for a static SPA, but it is unnecessary and should not be mistaken for API CORS.
- No service worker/PWA installability, error monitoring, real-user performance monitoring, or
  browser compatibility evidence was found.

## Perspective-specific acceptance gates

| Perspective | Minimum gate before calling it usable |
|---|---|
| New user | WorkOS sign-in, first-owner bootstrap, workspace creation/selection, logout, useful empty state |
| Admin | Invite/redeem, role changes, private-space isolation, session revocation, audit visibility |
| Mobile | 360 px and 390 px browser tests for navigation, composer, thread, files, keyboard, safe areas |
| Heavy chat user | Unread/needs-you correctness, reconnect catch-up, durable drafts, pagination, shortcuts |
| Agent developer | Install/scopes, run timeline, exact approval review, cancellation, receipts/provenance |
| Accessibility | Keyboard-only, focus-managed dialogs, screen-reader landmarks/names, 200% zoom, axe clean |
| Reliability | Two-browser ordering/reconnect test, dependency fault injection, idempotent command receipts |
| Security | Cross-workspace/DM isolation, auth revocation, upload/XSS/CSRF checks, secret and dependency scans |

## Evidence collected

- Frontend HTTP 200 from Vercel; production bundle built locally at 299.14 kB JS / 88.20 kB gzip.
- Web tests: 3/3 passed; they cover only local post creation, local agent approval, and static hierarchy.
- Gateway tests: 83/83 passed.
- Worker tests: 140/140 passed.
- The live route matrix also confirmed gateway JSON `401` for unauthenticated file-upload and agent
  stream/tool requests; invitation and session route families alone were absent from the expected
  product surface.
- Production API unauthenticated probes confirm some Fastify routing/CORS but cannot prove any
  authenticated capability, durable state, database subscription, worker, object, search index,
  notification, email, Ollama, telemetry, or restore behavior.

## Recommended proof order

1. Reconcile/redeploy the edge allowlist and add a route-matrix smoke test.
2. Decide and implement the exact WorkOS browser auth/session flow.
3. Replace prototype state with generated views/reducers and gateway SDK calls, beginning with the
   seven-step launch workflow rather than broad screen coverage.
4. Add a two-browser end-to-end suite and run it against staging, then production with a disposable
   workspace.
5. Prove file scan/search/notification workers and a timed restore drill before expanding invites.
