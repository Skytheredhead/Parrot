# Agent-native collaboration synthesis

Status: UI and product decision input, 2026-07-12

This artifact consolidates the source notes in [`agent-collaboration-sources.md`](./agent-collaboration-sources.md) into an explicit product and interface contract. It does not claim that agent participation itself is novel: Slack and Linear already present agents as installable teammates that can be mentioned, assigned work, and connected to external systems.

## Observed evidence

- Theo's proposal places agent work inside a bounded reply branch and asks for agents and humans in the same control plane.
- Slack's current product material demonstrates scoped app installation, agent mentions in channels/threads, organizational context, and external actions.
- Linear models agents as app users with profile/activity, team scope, delegation, session lifecycle, and continued human responsibility.
- Public practitioner reports support explicit invocation, selected-channel installation, confidence gates, and human approval as common noise and trust controls.

These observations establish a baseline, not a measured preference for this product's exact agent interface.

## Product inference

The opening is not “agents can speak in chat.” It is making each run understandable and governable inside the smallest relevant post/thread context:

1. The agent is a labeled participant, never a human-looking account or generic system event.
2. The run has an accountable human owner.
3. Input context is a visible manifest: post, selected thread/reply ancestry, explicitly attached files, and any additional authorized retrieval.
4. Read, draft, comment, internal mutation, external side effect, and administration are separate capabilities.
5. Progress events remain collapsed by default; durable findings become contributions.
6. Consequential work uses prepare → approve → commit rather than a chat message that merely says “done.”
7. Runs expose lifecycle, tools, source links, duration, cost where available, cancellation, retry, and a final receipt.
8. Permission revocation applies to active work and derived systems, not only future invocations.

Cost/token visibility, cross-agent disagreement, and mobile approval patterns remain product hypotheses that need usability evidence; they are not established user demand in the current source set.

## UI contract

### Identity

- Use a consistent non-human icon/avatar treatment and explicit `Agent` or role label.
- Show owner, installation scope, and current state on the agent profile.
- Never use decorative sparkle language as a substitute for identity or capability detail.

### Inline receipt

- The collapsed feed row shows agent name, action summary, state, source count, timestamp, and whether approval is required.
- Intermediate events do not become separate human-visible messages.
- The row remains attached to its source post and named thread.

### Review surface

- Show the exact proposed change before approval.
- Show context scope, tool classes, external destinations, duration, and cost when supplied.
- Approval and rejection must be explicit actions with a durable receipt.
- A completed result cites its source contributions and preserves uncertainty or disagreement.

### Attention

- Agent approvals and requested reviews may enter `Needs you` with an explicit clearing condition.
- Ambient agent completion does not automatically interrupt every participant.
- Per-agent and per-space notification/noise controls remain available.

## First-release boundary

Include explicit mentions or assignments, per-space scope, typed run state, inspect/cancel/retry, one consequential-action approval flow, source provenance, and human accountability.

Defer workspace-wide proactive listening, complex agent-to-agent hierarchies, broad autonomous external actions, and claims that an agent has a stable social persona. The first release should make one agent run legible and trustworthy before multiplying autonomy.
