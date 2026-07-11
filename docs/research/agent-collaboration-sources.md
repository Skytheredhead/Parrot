# Agent collaboration source notes

Status: initial primary-source synthesis
Reviewed: 2026-07-11

## What is already table stakes

Slack's current [agent product page](https://slack.com/ai-agents) and [2026 Dev Day demo](https://www.youtube.com/watch?v=AD1fsM-1NKQ) already position agents as teammates that can be mentioned in channels, DMs, and threads, receive conversational context, connect to third-party systems, and take actions. Linear's [AI Agents documentation](https://linear.app/docs/agents-in-linear) treats agents as app users that can be assigned work, comment, collaborate, and appear in workspace activity.

Therefore these claims are not differentiators on their own:

- “Agents are teammates.”
- “Mention an agent in a thread.”
- “Agents use workspace context.”
- “Agents can call external tools.”
- “Admins install agent apps.”

## Strong patterns to adopt

| Pattern | Source evidence | Product implication |
|---|---|---|
| Scoped installation | Linear admins select which teams an agent can access; Slack uses app scopes and admin controls. | Grant agents no ambient workspace-wide access by default. Scope to workspace, spaces, object types, tools, and actions. |
| Human accountability | Linear says delegation triggers agent action while the human teammate remains responsible. | Every autonomous or delegated run needs an accountable human/role visible in the UI. |
| Native participant identity | Linear agents are app users with profile/activity; Theo asks for agents in the same control plane. | Give agents distinct non-human identity, provider/owner information, status, and contribution history. Do not impersonate humans. |
| Typed run lifecycle | Linear's [Agent Session and Agent Activity](https://linear.app/developers/agent-interaction) model exposes working, waiting, error, completion, actions, prompts, and results. | Persist a run object with typed events; render progress separately from durable human/agent messages. |
| Context at the work object | Slack emphasizes that context lives where work happens; Theo asks to branch from a sub-comment. | Construct context from the post/thread/reply ancestry and explicitly attached artifacts, then expand only within permission. |
| Source visibility | Slack AI search returns citations to relevant artifacts. | Agent answers and summaries should link to authorized source contributions and reveal uncertainty. |
| Control over actions | Slack describes customer-controlled data access and guardrails; Linear agents cannot access admin/user-management functions. | Separate read, draft, comment, mutate, external side-effect, and admin capabilities. Require approval by policy, not ad hoc prompt wording. |

## Gaps in the reviewed product material

The official sources say relatively little about behavior that should be first-class here:

- Per-run cost/token visibility and budgets.
- A clear preview of the exact context an agent will receive.
- Preventing one noisy agent from dominating a human discussion.
- Cross-agent handoffs and conflicting agent conclusions.
- Approval queues for external side effects.
- Revoking access while a run is active.
- Redaction and deletion propagation into embeddings, caches, logs, and external tools.
- How summaries preserve disagreement, minority views, and superseded decisions.
- Mobile review of tool calls and approvals.
- Failure recovery, idempotency, cancellation, retries, and partial completion.

These gaps are a plausible product opening, but they are **our inference**, not proof that Slack or Linear lacks every capability.

## Recommended minimum agent contract

An installed agent should declare:

1. Human owner and accountable workspace role.
2. Read scopes and searchable data scopes.
3. Write/action scopes, split by internal and external side effects.
4. Trigger modes: explicit mention, assignment, subscription, schedule, or event.
5. Approval policy for each action class.
6. Data destinations, subprocessors, retention, and model provider.
7. Maximum run time, cost budget, retry policy, and concurrency.
8. Visible lifecycle events, cited results, error detail, and cancellation support.
9. A noise policy: progress events collapse by default; only durable findings become thread contributions.
10. Revocation behavior, including active-run cancellation and downstream cleanup limits.

The differentiating promise should be inspectable collaboration inside bounded posts and threads—not merely more bots that can speak.
