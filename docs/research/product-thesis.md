# Product thesis

Status: decision input, 2026-07-11

## The opening

The market already has topics, forum posts, thread inboxes, activity bumping, agent mentions, and AI search. The opening is narrower: a low-ceremony, durable boundary around a piece of shared work where humans and agents can contribute inside explicit context, and where decisions, tasks, files, and provenance remain recoverable without turning every conversation into a ticket.

The product should make later reading better without making initial posting feel bureaucratic.

## Core model

1. A **space** is a membership and attention boundary.
2. A **post** is the durable, permalinkable context envelope shown in a space feed.
3. A post can contain several **named threads**, each with a bounded purpose.
4. A thread contains real-time contributions from humans and agents.
5. A contribution may reply to a specific contribution. Full ancestry is stored, but default rendering stays shallow and provides explicit parent/context navigation.
6. **Decisions** and **tasks** are outcomes extracted from discussion and remain linked to their evidence.
7. An **agent run** is typed, inspectable work with input scope, progress, tool actions, approvals, cost, result, and accountable owner.
8. Activity can resurface a post without generating an interruptive notification.

## Differentiated promise

This is not “Slack with posts” and not “a forum with bots.” It should win when a team needs to:

- see the important work objects in a space without scanning every message;
- split one substantial post into several focused conversations;
- recover why a decision was made and what remains unresolved;
- invoke an agent on the smallest authorized branch of context;
- inspect what that agent read, did, spent, and produced;
- move between real-time exchange and async catch-up without changing tools;
- preserve useful social warmth across production teams, software groups, schools, and communities.

## Product principles

### Optimize for readers and returners

Titles, visible body previews, thread summaries, outcomes, and activity explanations should make a post understandable before it is opened. A notification link must restore exact reply context and return position.

### Add structure progressively

Publishing begins with title, body, and audience. Type, tags, assignee, due date, decision state, and automation appear only when useful. Misclassification must be cheap to repair.

### Separate relevance from interruption

Ambient unread, followed activity, mentions, assignments, approvals, and urgent escalation are different concepts. The personal inbox should contain finite obligations, not every unread event.

### Keep agents quiet and accountable

Agents act through mention, assignment, subscription, or schedule. Progress collapses by default. Consequential actions use prepare, approve, and commit states. Human and agent authorship can never be confused.

### Preserve authority at every derivative

Authorization applies before subscriptions, search indexing, previews, counts, summaries, attachments, and agent retrieval. Revocation propagates to active runs and derived systems.

### Prefer outcomes over engagement

Feed order may consider explicit importance, unread relevant activity, following, responsibility, and recency. Reactions and raw reply volume must not become engagement ranking.

## Source fidelity and deliberate divergence

Theo Browne explicitly asks for infinite nesting. The product should preserve arbitrary logical reply ancestry but avoid unlimited visual indentation. Branch focus, compact parent excerpts, and “view in context” navigation are the proposed reconciliation. This is a deliberate usability decision to validate on mobile, not a claim about the source.

## Release hypothesis

A team will consider switching if the product makes one repeated handoff materially better: discussion becomes a durable decision, task, file, or agent result without copying context to another system. The first release should prove that loop before attempting broad workflow replacement.
