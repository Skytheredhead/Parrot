# Gateway client SDK

Framework-neutral browser client for the provider-neutral gateway. It centralizes the exact route,
credential, CSRF, idempotency, abort, response-size, and structured-error behavior expected by the
backend. It deliberately does not wrap the generated SpacetimeDB bindings.

Use `@project-conversation/db-bindings` for authorized real-time subscriptions and reducers. Use
this package only for gateway capabilities: database connection tickets, file capabilities,
permission-safe search, agent stream tickets, agent tool calls, and invitation/auth flows as they
are added.

```ts
import { ProjectConversationClient } from "@project-conversation/client-sdk";

const gateway = new ProjectConversationClient({
  baseUrl: process.env.NEXT_PUBLIC_GATEWAY_URL!,
  csrfToken: () => readCsrfCookie(),
});

const connection = await gateway.databaseToken(workspaceId);
```

Bearer clients may supply `accessToken` instead. Session clients omit it, keep the secure session
cookie browser-managed, and supply the non-secret CSRF cookie value through `csrfToken` for
mutating requests. Never persist database or stream tickets; they are short-lived capabilities.

`createInvitation` returns the invitation bearer exactly once. Keep it in memory, send it only
through a channel the workspace administrator approves, and redeem it with `redeemInvitation` in a
JSON POST body. Never put it in analytics, logs, local storage, error reports, or a URL.

Session administration is available through `listSessions`, `revokeSession`, and
`revokeOtherSessions`. Revoking all other sessions requires a recently authenticated browser
session; treat `reauthentication_required` as a prompt to run the selected provider's explicit
reauthentication flow, then retry only after the user confirms.
