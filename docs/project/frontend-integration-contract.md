# Frontend integration contract

This repository owns the provider-neutral backend contract. The product UI is being built by the
user. This document identifies the stable seams the UI should consume without importing
private server state or recreating security-sensitive request logic.

## Two client surfaces

1. `@project-conversation/db-bindings` is generated from the exact SpacetimeDB 2.6.1 Rust schema.
   It owns caller-aware subscriptions, reducer calls, reducer receipts, and reconnect recovery.
2. `@project-conversation/client-sdk` wraps the browser-facing gateway for short-lived database
   tickets, upload/download capabilities, permission-safe search, agent stream tickets, tool calls,
   and authentication-adjacent flows.

Do not query private SpacetimeDB tables, reproduce gateway routes manually, or treat search/object
storage as authorization authorities. A database or stream ticket is a short-lived capability and
must remain in memory.

## Connection sequence

1. Complete authentication through the official `@workos-inc/authkit-react` provider. The browser
   receives only the public WorkOS client ID and Authentication API hostname. WorkOS API keys,
   M2M secrets, and refresh tokens outside AuthKit's managed cookie are server-only.
2. Construct `ProjectConversationClient` with the approved HTTPS gateway origin. Browser-session
   clients supply the readable CSRF cookie value; bearer clients supply an access-token callback.
3. Request `databaseToken(workspaceId)`. The gateway resolves the external identity to the current
   authoritative principal, checks `database:connect`, binds the current authorization epoch, and
   mints a short-lived ticket.
4. Build the generated `DbConnection` with the approved WSS SpacetimeDB endpoint and that ticket.
5. Subscribe only to the public views exported by `@project-conversation/db-bindings`.
6. On disconnect, show an explicit reconnecting state. Reconnect with a fresh database ticket,
   rebuild subscriptions, and reconcile pending commands through `my_command_receipts`.
7. On access revocation or an authorization-epoch change, discard the connection and every cached
   workspace object immediately.

Never store access, database, stream, upload, or download capabilities in local storage, analytics,
logs, URLs owned by the UI, error reports, or persisted client state.

## Parrot web runtime

The production shell in `apps/web` keeps the selected post-first interface while replacing demo
rows with caller-scoped SpacetimeDB views. A production build never silently enters demo mode. It
fails closed unless these public settings are present:

- `VITE_WORKOS_CLIENT_ID` (defaults to Parrot's public client ID)
- `VITE_WORKOS_API_HOSTNAME` (required unless staging dev mode is explicitly enabled)
- `VITE_WORKOS_DEV_MODE=true` only for the temporary WorkOS staging evaluation
- `VITE_GATEWAY_URL` (defaults to `https://parrotapi.skylarenns.com`)
- `VITE_SPACETIMEDB_URI`
- `VITE_SPACETIMEDB_DATABASE_NAME`
- `VITE_PARROT_WORKSPACE_ID` optionally pins the initial ticket scope

Production WorkOS configuration uses callback `https://parrot.skylarenns.com/callback`, login
`https://parrot.skylarenns.com/login`, sign-out return `https://parrot.skylarenns.com/signed-out`,
and exact CORS origin `https://parrot.skylarenns.com`. Vercel rewrites these routes to the SPA. With
a production WorkOS environment, configure a custom Authentication API hostname and leave dev mode
off so AuthKit can use its secure HTTP-only refresh cookie. The explicit staging dev-mode path
stores refresh state in local storage and is a launch blocker; it is acceptable only for the current
one-person, non-sensitive evaluation.

AuthKit's `getAccessToken()` is supplied directly to the gateway SDK and is never copied into React
state or application storage. The web client calls `databaseToken(workspaceId)` before every initial
connection or reconnect and gives only the returned short-lived ticket to `DbConnection`. Logout
closes the socket, discards its connection reference and workspace cache, then calls AuthKit
`signOut`. A gateway 401 or authorization fence must follow the same teardown path rather than retry
forever.

For the first owner, no workspace UUID exists yet. When no configured or previously discovered UUID
is available, the browser may use the in-memory WorkOS access token for one narrowly scoped direct
SpacetimeDB connection that subscribes only to `current_user` and `my_workspaces`. Existing accounts
discover their first caller-visible workspace; empty accounts get an explicit `bootstrap_owner`
action with workspace name `Parrot`. As soon as `my_workspaces` yields an ID, the discovery socket is
closed and all normal traffic switches to gateway-minted database tickets. Only that non-secret UUID
is retained in local storage. Tokens, rows, commands, and tickets are never persisted. A forbidden
stored UUID is deleted and rediscovered rather than replaced with a fabricated value. This exception
depends on the approved SpacetimeDB endpoint accepting the exact WorkOS identity token for these two
caller-safe views and bootstrap reducer; if production disables that path, bootstrap requires a
gateway endpoint instead.

## Authoritative public views

The generated package is the source of truth for the current list. The core surfaces include:

- identity/workspace: `current_user`, `my_workspaces`, `my_workspace_memberships`,
  `my_workspace_lifecycles`, `my_workspace_legal_holds`, `my_workspace_exports`
- collaboration: `visible_spaces`, `visible_posts`, `visible_named_threads`,
  `visible_contributions`, `visible_reply_ancestry`, `visible_post_tags`,
  `visible_post_mentions`, `visible_post_reactions`, `visible_post_pins`,
  `visible_post_activity`, `my_post_states`, `visible_polls`, `visible_poll_options`
- private communication: `visible_direct_conversations`, `visible_direct_participants`,
  `visible_direct_messages`, `visible_direct_reply_ancestry`, `my_direct_read_states`,
  `visible_dm_promotion_proposals`, `visible_dm_promotion_sources`,
  `visible_dm_promotion_consents`
- outcomes/files: `visible_decisions`, `visible_tasks`, `visible_files`, `my_file_uploads`
- attention/audit: `my_notifications`, `my_command_receipts`, `visible_audit_log`
- attention/presence: `visible_presence`, `my_notification_preferences`
- agents: `visible_agent_installations`, `visible_agent_scopes`, `visible_agent_tool_policies`,
  `visible_agent_runs`, `visible_agent_run_events`, `visible_agent_tool_calls`,
  `visible_approvals`, `visible_agent_context_manifests`

Worker-only views such as pending outbox, notification/digest delivery plans, workspace-export
generation/cleanup plans, search documents, file processing, context candidates, and agent-work
queues require an enabled service grant and must never be subscribed to by the browser.
Direct messages are intentionally absent from search. Workspace owners and administrators have no
role-based bypass into a direct conversation; render only rows supplied by the caller-aware views.

## Mutations and receipts

All public reducer arguments and enum types come from the generated package. Every user-visible
mutation should use a fresh command ID and preserve it across transport retries. A transport retry
may repeat the same command ID; a distinct user action must use a distinct command ID. Treat the
matching receipt as the authoritative resolution after a reconnect.

Presence uses `heartbeat_presence` as disposable advisory state. It never grants access, and the UI
must compare the aggregate `expires_at` value with its own current time because bounded cleanup may
lag. Notification settings use `set_notification_preference`; workspace defaults may be overridden
per visible space. Local mute and digest minutes use an IANA-style timezone identifier. The durable
digest authority applies a once-per-local-date cursor, while the worker performs daylight-saving
conversion and reconciles ambiguous provider outcomes before any retry.

Mentions and replies are direct-attention notification kinds. A thread contribution
notifies the parent contribution author, or the root-post author for a top-level contribution; a
direct-message reply notifies the parent-message author. The UI may play a short sound only after a
user gesture has unlocked browser audio, only for a newly inserted unread mention or reply that was
not authored by the current user, and only when mute/preferences allow it. Hydrate the initial cache
without sound and retain a session-only notification-ID watermark so reconnect/replay never repeats
the sound. This is active-browser behavior, not Web Push
and not a guarantee when the tab or browser is closed.

Workspace owners configure explicit retention/grace inputs with `configure_workspace_lifecycle`.
`request_workspace_deletion` immediately removes the workspace from human and service views and
starts the configured grace window. Epoch-bound scheduler batches clear ephemeral notification
permits and presence, while durable jobs and agent state remain paused so cancellation can recover
and reconcile ambiguous external effects safely. `cancel_workspace_deletion` restores authoritative
access subject to fresh authorization. `finalize_workspace_deletion_fence` is irreversible after the
grace window and only then drains durable work through bounded batches. It is an access fence, not
proof that search, objects, backups, or providers have physically purged data; never label the
workspace as fully erased until downstream reconciliation exists.

Platform operators place and release legal holds; owners can see hold status but never private hold
reasons. Owners request bounded exports with `request_workspace_export` and track status through
`my_workspace_exports`. That view deliberately never exposes the artifact key, hash, or provider
version. Expiry and irreversible deletion enqueue exact conditional cleanup and retain private
metadata until deletion or not-found is confirmed. Do not implement a download button until the
gateway exposes a short-lived owner-authorized retrieval capability.

Optimistic UI is allowed only when it can roll back. Never optimistically elevate a role, reveal a
private object, approve an agent tool, mark a quarantined file clean, or display a search result that
has not been returned through an authorized view/gateway response.

## Gateway conventions

- All browser calls use `credentials: include`, `cache: no-store`, and redirect rejection.
- Session-backed non-GET calls require the session-bound CSRF token. Bearer calls use
  `Authorization: Bearer` and do not send the CSRF token.
- Tool execution requires an explicit 8–200 character idempotency key. The SDK never retries it
  automatically.
- `GatewayClientError` exposes the HTTP status, stable error code, safe message, request ID, and
  optional retry delay. UI copy should branch on the stable code, not parse the message.
- Uploads are three-stage: obtain a checksum-bound single-write capability, PUT directly with the
  exact required headers, then call `completeUpload`. A completed upload is still quarantined until
  the worker records a clean scan.
- Download capabilities are returned only for immutable clean object versions. Navigate or fetch
  them directly without copying them into application URLs or telemetry.
- Search cursors are bound to the principal, workspace, normalized query, authorization epoch, and
  expiry. Discard a cursor whenever any of those inputs changes.
- Invitations use `createInvitation` and `redeemInvitation`; the creation token is a one-time bearer
  and must never be persisted or placed in a URL. Session management uses `listSessions`,
  `revokeSession`, and `revokeOtherSessions`; bulk revocation can require provider reauthentication.

The Parrot web shell implements permission-safe search only through the gateway SDK, with debounced
queries, stale-response suppression, explicit loading/error/empty states, and cursor pagination.
Search results never grant visibility; live post cards remain sourced from caller-scoped views.
Files use the three-stage checksum/capability/completion flow and remain visibly quarantined until
`visible_files` reports `Clean`; only clean rows expose download actions. Named threads use
`create_named_thread`, replies use `add_contribution` with `ContributionKind.Message`, and expanded
thread content is rendered from `visible_contributions` rather than optimistic placeholder data.

## Agent runs

Start, cancel, inspect, approve, and retry agent work through the generated reducers/views. The
gateway stream ticket is optional progressive transport, not the authority. Reconcile terminal
state through `visible_agent_runs` and ordered `visible_agent_run_events` after reconnect. Tool-call
approval must display the exact tool, normalized arguments hash, effect class, and expiry supplied
by the authoritative views.

## Current intentional gaps

The checked-in web runtime is deployable once the public settings and initial workspace ID are
injected, but the supplied `sk_test` credential belongs to WorkOS staging. Production authentication
therefore remains blocked on a production WorkOS environment plus custom Authentication API domain,
or a separately reviewed BFF session architecture. Export retrieval, provider-specific deletion
conformance, and production restore evidence also remain approval-gated. The UI should not fabricate
flows for rows marked `not started` or `blocked on decision`.
