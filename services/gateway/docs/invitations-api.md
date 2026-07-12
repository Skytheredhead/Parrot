# Invitation API

Both routes require an authenticated gateway identity. Cookie-authenticated requests also require the
normal origin and session-bound CSRF checks. Invitation bearer material is accepted only in JSON POST
bodies, never in a URL, and every response carries `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

## Create an invitation

`POST /v1/invitations`

```json
{
  "workspaceId": "workspace-1",
  "role": "member",
  "spaceIds": ["space-1"],
  "email": "invitee@example.com",
  "expiresInSeconds": 604800,
  "useLimit": 1
}
```

- `role` is `admin`, `member`, or `guest`.
- `spaceIds` is optional and contains at most 50 opaque IDs.
- `email` is optional; when present it is normalized and bound to the redeeming verified identity.
- `expiresInSeconds` defaults to 7 days and must be between 5 minutes and 30 days.
- `useLimit` defaults to 1 and must be between 1 and 100.

The caller must pass live `invitation:create` authorization for the workspace. Principal-global and
authorized-workspace rate limits run before storage. A successful `201` response returns the opaque
bearer exactly once:

```json
{
  "invitationId": "00000000-0000-4000-8000-000000000000",
  "token": "inv1.00000000-0000-4000-8000-000000000000.REDACTED",
  "expiresAt": "2026-07-18T12:00:00.000Z",
  "useLimit": 1
}
```

The durable record receives only the keyed digest and key ID, never `token`.

## Redeem an invitation

`POST /v1/invitations/redeem`

```json
{ "token": "inv1.00000000-0000-4000-8000-000000000000.REDACTED" }
```

Redemption requires a current human principal with an authoritative verified email. IP and
principal-global invitation limits run before the atomic store operation. The durable adapter
constant-time verifies one of the supplied keyed hashes and, in one transaction, rechecks expiry,
revocation, optional email binding, membership policy, and remaining uses before writing membership
and audit state.

A successful response contains membership metadata and never repeats the bearer token. Malformed,
unknown, tampered, expired, revoked, email-mismatched, exhausted, and otherwise ineligible invitations
all return the same status and error payload:

```json
{
  "error": {
    "code": "invitation_unavailable",
    "message": "Invitation is unavailable"
  },
  "requestId": "..."
}
```

The status is `404`. Authentication and rate-limit failures retain the gateway-wide `401` and `429`
contracts; no invitation lookup is performed before those checks pass.
