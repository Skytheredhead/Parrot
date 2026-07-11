# Initial information architecture options

Status: requires user selection, 2026-07-11

All three models preserve the same core graph:

```text
Workspace → Space → Post → Named thread → Contribution → Contextual reply
                         ↘ Decision / Task / File / Agent run
```

They differ in the default surface, attention contract, density, and how a user returns to work.

## Model A — Living posts

Recommended.

### Product behavior

- **Primary object:** a socially legible, substantial post.
- **Workspace/space organization:** a compact space switcher leads to a feed of posts; spaces define audience and rules, not message streams.
- **Home:** followed and relevant posts, with a small finite “Needs you” strip above ambient activity.
- **Post creation:** title, visible body, audience, and attachments first; type and outcome fields appear progressively.
- **Threads:** several named threads beneath a post; each shows purpose, latest activity, summary, unresolved state, and human/agent participants.
- **Inline replies:** full ancestry stored, one level rendered with parent excerpt and “view branch” navigation.
- **Direct messages:** secondary, immediate, and private; participants can consensually promote a useful exchange into a post.
- **Decisions/tasks:** extracted from selected contributions and pinned to the post with source links, rationale, dissent, owner, and history.
- **Notifications:** resurfacing changes feed position; only mention, assignment, approval, followed activity, or explicit urgent escalation enters “Needs you.”
- **Search/rediscovery:** posts are first in results; threads, messages, files, outcomes, and agent results remain directly addressable.
- **Agents:** an agent is mentioned or assigned inside one thread; the run appears inline as collapsed typed state with context manifest, tools, cost, approval, and final cited contribution.
- **Mobile:** Home, Spaces, New, Inbox, and You; a post opens as a full-width page with a sticky compact parent and stacked thread summaries.
- **Switching reason:** it feels as easy as a group feed while preventing one substantial topic from collapsing into one giant comment chain.

### Why it does not collapse into an incumbent

- Unlike Slack/Mattermost, the space never defaults to every message.
- Unlike Twist/Zulip, one substantial post can hold several independently bounded discussions and outcomes.
- Unlike Discord Forums/Discourse, creating and following a post remains socially lightweight.
- Unlike Reddit/Facebook, priority is responsibility and explicit importance, not engagement.
- Unlike Linear, the post is not inherently an issue and works for announcements, questions, media, incidents, and community life.

### Scenario wireframe content

Sports production workspace: `Saturday Broadcast`; space: `Game day`; post: `Final rundown — Panthers vs. Tigers`; threads: `Opening tease`, `Lower thirds`, `Rain contingency`; decision: `Move aerial open to 7:42`; agent run: `Rundown assistant checked 12 source files — approval needed to update cue sheet`.

### Main risk

The feed can become Facebook-like without improving work. Multiple threads, finite obligations, outcomes, and agent accountability must prove their value in testing.

## Model B — Signal desk

### Product behavior

- **Primary object:** a post requiring a discernible next state: observe, discuss, decide, deliver, or resolve.
- **Workspace/space organization:** spaces are accessed through a command menu and compact index; the dominant surface is a personal operational desk, not a left-channel rail.
- **Home:** a finite queue of mentions, assignments, approvals, followed changes, and expiring decisions. Ambient space activity lives behind a separate pulse view.
- **Post creation:** quick post by default; `request`, `decision`, `incident`, or `release` templates add only the relevant fields.
- **Threads:** named workstreams appear as flat rows with status, last meaningful change, owner, and unread-relevant count.
- **Inline replies:** chronological thread with compact quoted parent and keyboard navigation.
- **Direct messages:** present but deliberately absent from the operational queue unless the user marks something for follow-up.
- **Decisions/tasks:** more prominent than in Model A; they can move through proposed, awaiting confirmation, accepted, superseded, or complete.
- **Notifications:** every inbox item explains why it is there and what clears it.
- **Search/rediscovery:** command-first object search with filters and saved views; no result metadata appears before authorization.
- **Agents:** runs resemble accountable work sessions with owner, scope, checkpoints, proposed changes, approval, and receipt.
- **Mobile:** opens to the finite queue; the selected post becomes a single column with threads and approvals ordered by responsibility.
- **Switching reason:** teams with high operational load get a trustworthy action surface without forcing every conversation into a project-management system.

### Why it does not collapse into an incumbent

- Unlike Linear, the queue includes social posts and discussions that are not issues.
- Unlike Slack Activity, inclusion and completion are explicit and explainable.
- Unlike Teams, files, outcomes, agent work, and discussion remain under one post instead of tabs/apps.
- Unlike Twist, multiple thread workstreams and structured agent approvals coexist under the parent.

### Scenario wireframe content

Software workspace: `Core Platform`; post: `Release candidate 2.4 — ship or hold?`; threads: `Auth regression`, `Mobile reconnect`, `Docs gaps`; proposed decision: `Hold until token-refresh fix is verified`; agent run: `Release Scout completed 18 checks; 2 require review`.

### Main risk

Responsibility can dominate social collaboration and make the product feel like a ticketing tool. Ambient, exploratory, and community posts must remain first-class.

## Model C — Daily briefing

### Product behavior

- **Primary object:** a curated daily briefing assembled from posts, with each original post remaining authoritative.
- **Workspace/space organization:** spaces publish posts into a shared edition; users can read by workspace, space, or scheduled catch-up window.
- **Home:** an editorial sequence: `Needs you`, `What changed`, `Decisions`, `Agent results`, and `Around your spaces`, each finite and explainable.
- **Post creation:** an open social composer with a strong visible preview; authors choose audience and optional notification target.
- **Threads:** a post page lists named conversations as a table of contents; activity summaries identify what changed since the reader's last visit.
- **Inline replies:** branch focus preserves ancestry without indentation.
- **Direct messages:** an immediate private lane with explicit promotion to an authorized post.
- **Decisions/tasks:** summarized in the next edition while remaining anchored to their source post and messages.
- **Notifications:** most activity waits for the next chosen briefing; mentions, assignments, approvals, and urgent escalation can interrupt.
- **Search/rediscovery:** editions aid recall, but search always returns canonical objects rather than generated digest text alone.
- **Agents:** catch-up and summarization agents are prominent, cite every source, preserve disagreement, and cannot replace the record.
- **Mobile:** a calm article-like reading flow with clear progress and a fixed return to exact context.
- **Switching reason:** async groups regain awareness without continuous unread pressure.

### Why it does not collapse into an incumbent

- Unlike Twist, the digest is a first-class attention layer rather than only an inbox of threads.
- Unlike Slack recaps, structure exists before summarization and every digest item expands to the canonical post/thread/outcome.
- Unlike a newsletter, users can immediately enter live bounded discussions and act.
- Unlike social feeds, the edition is finite and not engagement ranked.

### Scenario wireframe content

Student organization: `Campus Events Board`; post: `Spring social — venue and rain plan`; threads: `Transportation`, `Accessibility`, `Backup location`; poll outcome: `Student Center selected, 34–8`; agent result: `Accessibility checker found two missing venue details`.

### Main risk

Digest freshness may hide immediate collaboration or create misplaced trust in summaries. Exact source expansion and a clear live-activity path are mandatory.

## Recommendation

Start with **Model A — Living posts** and borrow Model B's explainable finite inbox plus Model C's optional scheduled briefing. That combination makes the post/thread distinction visible immediately while keeping action and catch-up calm. Do not merge all three home surfaces; one default must remain legible.
