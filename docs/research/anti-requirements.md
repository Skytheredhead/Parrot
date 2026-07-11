# Anti-requirements

Status: decision input, 2026-07-11

The following outcomes would violate the product thesis even if the feature list appears complete.

## Information model

- Do not make an undifferentiated message stream the primary space surface.
- Do not rename a message “post” while leaving its durability, context, and rediscovery unchanged.
- Do not make threads disposable side panels that disappear as a channel advances.
- Do not require every post to declare a type, tag, assignee, status, and due date.
- Do not visually indent replies without limit on mobile or desktop.
- Do not detach decisions or tasks from the discussion that produced them.

## Attention

- Do not equate unread with important.
- Do not rank by reactions, reply volume, or other engagement signals.
- Do not send an interruptive notification merely because an old post resurfaced.
- Do not make inbox zero a requirement for understanding the workspace.
- Do not allow agents to narrate every intermediate step into the human conversation.

## Agents

- Do not place agents only in a separate AI sidebar.
- Do not let a client impersonate another human, an agent, an administrator, or a system event.
- Do not infer workspace-wide read access from installation.
- Do not let prompt text expand server-enforced permissions.
- Do not execute destructive, external, permission-changing, or money-moving actions without policy-based approval.
- Do not present uncited summaries or derived answers as the authoritative record.

## Security and data

- Do not rely on frontend-only authorization.
- Do not expose public tables containing multi-tenant private data and hope queries remain filtered.
- Do not index, count, preview, summarize, or retrieve unauthorized content.
- Do not put large binary files in the real-time database merely because it supports bytes.
- Do not create an unrepairable dual-write path between the source database and search/notification systems.
- Do not retain deleted or revoked content indefinitely in indexes, caches, agent logs, or backups without documented policy.

## Experience and design

- Do not ship a renamed Slack sidebar or a generic dashboard template.
- Do not use giant rounded cards, nested cards, glass-heavy surfaces, decorative AI sparkles, or meaningless gradients.
- Do not hide the composer, reply target, audience, or parent context.
- Do not preserve desktop density on mobile at the expense of usable width.
- Do not ship dead controls, fabricated analytics, fake customer claims, or visual-only core actions.

## Scope

- Do not delay the core loop for calls, screen sharing, native mobile apps, enterprise billing, full Slack import, public discovery, or algorithmic social feeds.
- Do not turn the release into a complete project-management suite.
- Do not promise that interface design alone fixes team culture, leadership expectations, or unlimited communication load.
- Do not publish under a provisional name or unapproved domain.
