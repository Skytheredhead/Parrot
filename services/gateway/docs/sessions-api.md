# Session administration API

These routes administer sessions for the current authoritative human principal. They do not implement
login, logout redirects, cookie issuance, recovery, or provider-specific UI. Responses contain no
tokens, cookies, IP addresses, raw user agents, provider subject IDs, or device fingerprints. The
gateway-wide `Cache-Control: no-store` and `Referrer-Policy: no-referrer` headers apply.

## List current sessions

`GET /v1/sessions`

The response contains at most 50 active sessions and only this allowlist:

```json
{
  "sessions": [
    {
      "sessionId": "session-opaque-id",
      "current": true,
      "createdAt": "2026-07-10T12:00:00.000Z",
      "lastSeenAt": "2026-07-11T12:00:00.000Z",
      "expiresAt": "2026-07-18T12:00:00.000Z",
      "kind": "browser"
    }
  ]
}
```

`kind` is `browser` or `api`. The durable adapter derives ownership from the authoritative principal;
request parameters cannot select another user.

## Revoke one session

`DELETE /v1/sessions/:sessionId`

The durable adapter atomically rechecks ownership and current authorization state, revokes the session,
propagates the provider revocation, and appends audit metadata. Success returns:

```json
{ "revoked": true }
```

Malformed, unknown, foreign, and already-revoked IDs all return `404` with:

```json
{
  "error": { "code": "session_unavailable", "message": "Session is unavailable" },
  "requestId": "..."
}
```

## Revoke every other session

`POST /v1/sessions/revoke-others`

This retains the exact current session and revokes all other sessions owned by the principal in one
atomic operation. It requires both a current session ID and a provider-verified authentication-time
marker no older than `SESSION_FRESH_AUTH_MAX_AGE_SECONDS` (default 300 seconds). A refresh-token or
access-token issuance timestamp is not a valid replacement. Missing or stale fresh authentication
returns `403` and `reauthentication_required` before the durable operation.

```json
{ "revoked": true, "revokedCount": 2 }
```

## Browser and client-SDK requirements

- Cookie-authenticated `DELETE` and `POST` requests must include the trusted `Origin` and the existing
  session-bound CSRF header/cookie pair. Bearer clients must not mix cookie authentication.
- The SDK must treat session IDs as opaque, render only the documented metadata, and never persist a
  session list longer than the response lifecycle.
- If the current session is revoked, the client must clear private state and enter the provider's
  existing signed-out/reauthentication flow; this API does not issue or clear provider cookies.
- On `reauthentication_required`, the client must invoke the approved provider's genuine step-up or
  reauthentication flow and retry only after a new identity carries a recent verified auth-time marker.
- `session_unavailable` must be shown as a generic stale/unavailable result. The SDK must not probe IDs
  or infer whether a session belongs to another account.
- Principal-global and route-specific IP limits apply to destructive calls. Clients should honor
  `Retry-After` on `429` and must not automatically fan out revocation retries.
