# Project Conversation UI prototype

This package is the research-grounded frontend prototype for the selected **Community Post Feed** direction.

It deliberately uses a Discord-familiar dark community shell while changing the primary communication model:

- spaces show substantial posts instead of every individual message;
- one post can contain several bounded named threads;
- decisions and agent work remain attached to their source post;
- `Needs you` is separate from ambient unread activity;
- agents are labeled participants with inspectable approval state.

The prototype uses deterministic local state only. It does not connect to the repository's gateway, SpacetimeDB module, authentication, files, search, or notification services.

## Run locally

From the repository root with the pinned Node 24 toolchain available:

```bash
PATH="$PWD/.tools/node/current/bin:$PATH" pnpm --filter web dev
```

## Checks

```bash
PATH="$PWD/.tools/node/current/bin:$PATH" pnpm --filter web test
PATH="$PWD/.tools/node/current/bin:$PATH" pnpm --filter web build
```

The selected source visual is `reference-community-post-feed.png`; the comparison evidence and implementation captures live under `qa/`, with the final review in `design-qa.md`.
