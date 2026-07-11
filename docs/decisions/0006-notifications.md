# ADR 0006: Notification attention and delivery model

- **Status:** Proposed; external channels, provider/domain, defaults, and retention require user approval
- **Date:** 2026-07-11
- **Scope:** In-app attention, email/push delivery, preferences, retries, deduplication, and privacy

## Context

The product should help a team notice decisions and blocked work without reproducing a noisy chat firehose. Humans, agents, and services can create high-volume activity, but reducers cannot send email or push notifications. Delivery is an external effect that may be duplicated, delayed, rejected, or observed after a permission change.

## Decision

### Attention tiers

Every notification intent has one product tier independent of its transport:

| Tier | Examples | Default behavior |
| --- | --- | --- |
| `action_required` | Assignment, approval request, invitation, explicit decision request | “Needs me” inbox; eligible for immediate external delivery |
| `direct` | Mention, direct reply, DM | “Needs me” inbox; immediate or batched per preference |
| `followed` | Activity on a followed thread/task/space | Following inbox; batched by default |
| `ambient` | General space activity, routine agent progress | Unread/catch-up state only; no per-event external alert |

`urgent` is a separate, permissioned escalation flag with workspace rate limits and audit history; it is not a fifth catch-all tier. Agent progress is collapsed by run. Only an agent's approval request, blocked state, failure requiring action, or final result produces a discrete notification by default.

The in-app inbox has finite “Needs me” and “Following” views. Read/unread means seen; resolved/done means the underlying action is complete. Those states remain separate. Multiple replies or reactions on one resource coalesce while retaining an event count and latest actor/time.

### Authoritative model and fan-out

Private SpacetimeDB tables hold notification intent, recipient inbox item, user/workspace preference, digest cursor, device/subscription endpoint reference, delivery job, delivery attempt, and dead letter. A domain reducer commits the domain event and notification intent atomically. Deterministic fan-out creates recipient items from current memberships and preferences; high-volume fan-out may be leased to a worker, but the source intent and cursor remain authoritative and replayable.

No reducer calls email, push, or webhook providers. A worker observes an authorized outbox View, rechecks the recipient's current permission and preference immediately before delivery, and sends a minimal payload. External previews of private content are off by default; email/push may say that activity needs attention and link back to an authenticated page.

### Delivery semantics

Delivery is at least once. A stable key such as `intent_id:recipient_id:channel:digest_bucket` provides application and provider idempotency where supported. Each attempt records a sanitized provider message ID, outcome class, next attempt, and correlation ID—not body content or endpoint secrets.

Retry transient network, timeout, rate-limit, and provider 5xx failures with bounded exponential backoff and jitter, honoring `Retry-After`. Do not retry permanent address, authentication, malformed-payload, or revoked-endpoint failures. After the configured attempt/time budget, move the job to a dead letter with an audited operator replay path. If the outcome is uncertain, query/reconcile with the provider before resending when the provider supports it.

Digest jobs use a unique recipient/channel/time-zone bucket, deterministic contents, and a persisted cursor so retries cannot create a second digest. They skip already-resolved actions and respect quiet hours. Active users receive in-app updates instead of redundant external nudges where presence is reliable.

Preference changes, unsubscribe, membership removal, account disablement, and endpoint revocation cancel pending delivery at the final authorization check. Existing in-app items become inaccessible when their resource permission is removed. Device endpoints and email addresses are encrypted/referenced as secrets and never exposed through public subscriptions.

### Initial channel policy

The production baseline is the in-app inbox. Email may be added for verification/invites, action-required items, and digests. Web Push/PWA or native push is deferred until the user approves its product value and provider/operational footprint.

**User approval is required for:** email provider, sender domain and mailbox policy, push provider/platform, default preview policy, quiet hours/digest defaults, retention periods, escalation permissions, rate limits, and delivery cost ceiling. DNS, provider accounts, devices, or production endpoints are not provisioned before approval.

### Required evidence before production

- A domain event and its notification intent cannot diverge; duplicate fan-out/delivery converges on one logical inbox item.
- Membership or preference revocation between enqueue and delivery prevents content disclosure.
- Retry, rate-limit, timeout, uncertain outcome, provider outage, and dead-letter replay are deterministic and observable.
- Digest replay does not duplicate mail; coalescing does not hide an unresolved action.
- Cross-tenant recipients, endpoints, counts, and previews are inaccessible.
- Agent loops and reaction storms cannot exceed per-actor/workspace/channel budgets.

Track oldest pending age, delivery success/temporary/permanent failure by channel, retries, dead letters, dedupe/coalescing rate, unsubscribe/revocation suppressions, digest lateness, action-required age, and urgent-rate-limit denials. Alert on sustained queue age or failure rate, not individual transient failures.

## Alternatives rejected

- **Notify on every activity event:** creates unbounded attention debt and makes agent activity unusable.
- **Provider send inside reducers:** delivery is nondeterministic and can duplicate on replay.
- **Exactly-once delivery claims:** transports do not provide an end-to-end exactly-once guarantee.
- **Put private message text in every push/email:** endpoint and lock-screen exposure can outlive authorization.
- **Mark read as resolved:** viewing an assignment does not complete it.

## Current official evidence

Accessed 2026-07-11:

- [SpacetimeDB reducer transactions](https://spacetimedb.com/docs/functions/reducers/)
- [SpacetimeDB Views](https://spacetimedb.com/docs/functions/views/)
- [RFC 8030: Generic Event Delivery Using HTTP Push](https://www.rfc-editor.org/rfc/rfc8030)
- [RFC 9110: `Retry-After` semantics](https://www.rfc-editor.org/rfc/rfc9110#name-retry-after)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
