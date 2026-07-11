# Source ledger

Status: initial pass
Last reviewed: 2026-07-11
Scope: Theo source segment, eight high-signal videos, and primary/official product documentation. X and Reddit research belongs in separate ledgers and is not represented here.

## Evidence rubric

- **Strong:** primary source or official documentation directly describing observable behavior; timestamped first-party demonstration.
- **Moderate:** independent or practitioner walkthrough demonstrating the interface, with behavior cross-checkable in official docs.
- **Limited:** vendor marketing, unsupported numerical claim, old interface, or a source that describes intent rather than outcomes.
- Confidence describes confidence in the recorded observation, not confidence that the product solves the underlying user problem.
- Publication dates come from YouTube metadata or the page. Undated living documentation is labeled “current; accessed 2026-07-11.”

## High-signal video reviews

### V1 — Theo's proposal

- **Direct link:** [I don't have time to build these things, will you?](https://www.youtube.com/watch?v=wEAb0x3wTRc&t=2195s)
- **Creator / date:** Theo - t3.gg / 2026-06-22
- **Relevant timestamps:** 36:44-37:37 Slack and thread criticism; 37:37-38:33 agents and desired attention behavior; 38:33-39:45 Facebook/Workplace post model; 39:45-40:47 post/thread primitives; 40:47-41:29 agent content system and open standard.
- **Behavior demonstrated/described:** active old discussions resurface; posts contain comment/reply branches; an agent explores a sub-comment and returns in context; groups contain work posts.
- **Problem addressed:** Slack optimizes sending while active threads, reply targets, reading, and prioritization degrade.
- **Strengths:** direct problem-owner articulation; unusually precise primitive and resurfacing statements.
- **Weaknesses:** conceptual, not a shipped demo; permissions, notifications, mobile, moderation, and the meaning of “standard” are absent; “infinite nesting” may be difficult to render.
- **Product implication / confidence:** Post is the durable envelope and agent run is contextual work inside it. Preserve logical reply ancestry and activity resurfacing. **High.**

### V2 — Slack Dev Day 2026

- **Direct link:** [The Future of AI Agents](https://www.youtube.com/watch?v=AD1fsM-1NKQ)
- **Creator / date:** Slack / 2026-06-17
- **Relevant timestamps:** 6:57-7:35 agents in teams/channels/canvases and “context lives where work already happens”; 12:52-16:49 workspace seeding, agent scaffolding and permissions; 18:38-19:29 third-party context, mobile work and a thread-to-PR example; 20:18-20:47 data/billing agents invoked in threads.
- **Behavior demonstrated:** developers seed realistic Slack workspaces, scaffold agents, grant scopes, install them, mention them in threads, connect external tools, and receive work products such as a PR.
- **Problem addressed:** agents lack the conversational and enterprise context needed to act without copying work among tools.
- **Strengths:** first-party current demo; concrete developer and end-user flows; visible scopes and thread invocation.
- **Weaknesses:** conference presentation and vendor claims; little evidence about failure handling, noisy output, least privilege, approval, or long-term discoverability.
- **Product implication / confidence:** “agents as teammates” and thread invocation are table stakes. Differentiate through bounded context, legible runs, approvals, rediscovery, and durable post state. **High behavior / Limited outcome claims.**

### V3 — Slack AI and Agentforce overview

- **Direct link:** [Dreamforce 2024: Working with AI and agents in Slack](https://www.youtube.com/watch?v=Rt_-zeeZdSo)
- **Creator / date:** Slack / 2025-01-13
- **Relevant timestamps:** 1:08-2:41 information-finding and tool-switching problem; 2:41-4:04 Slack work OS and three-part AI strategy; 4:53-6:13 contextual grounding/security; 6:45-8:00 search answers, thread summaries, and channel recaps; 9:34-12:30 Agentforce examples.
- **Behavior demonstrated:** cited natural-language answers, one-click summaries of long threads, daily selected-channel recaps, assistants in dedicated surfaces, and action-taking agents grounded in Slack context.
- **Problem addressed:** workers cannot find or catch up on fragmented knowledge; generic models lack organizational context.
- **Strengths:** clear catch-up primitives and cited retrieval; explicitly recognizes data security, privacy, accuracy, and quality concerns.
- **Weaknesses:** fixes message overload after it exists rather than changing the primary object; claims and savings are vendor-reported; summarization can hide disagreement or provenance if not expandable.
- **Product implication / confidence:** summaries must cite and open source contributions; recap should complement, not replace, durable structure. **High behavior / Limited metrics.**

### V4 — Discord Forum Channels walkthrough

- **Direct link:** [Discord Forums: Everything You Need to Know!](https://www.youtube.com/watch?v=Q8l8Bmq-7mE)
- **Creator / date:** Gehsture / 2022-09-23
- **Relevant timestamps:** 0:08-0:33 forum versus endless text channel; 0:44-1:32 setup, guidelines, permissions; 1:32-2:06 tags, post thread, OP identity; 2:31-3:11 post creation; 3:11-3:44 tags and publishing.
- **Behavior demonstrated:** a forum channel contains titled posts; posts open into chat-like threads; admins add guidelines, permissions, tags, and default reactions.
- **Problem addressed:** many simultaneous conversations in a large server talk over and bury one another.
- **Strengths:** creation remains simple; retains Discord identity and chat comfort; tags and guidelines add light structure.
- **Weaknesses:** short launch-era walkthrough, no long-term usage; forum is a special channel silo rather than the server-wide default; no durable decisions/tasks or agent lifecycle shown.
- **Product implication / confidence:** post-first structure can feel social and low-friction, but making it an optional channel type risks leaving the rest of the product message-first. **Moderate.**

### V5 — Zulip self-hosted walkthrough

- **Direct link:** [Zulip — a Free, Open Source, Self Hosted Alternative](https://www.youtube.com/watch?v=hMvvqrUeNvw)
- **Creator / date:** Awesome Open Source / 2019-08-24
- **Relevant timestamps:** 21:29-22:03 streams/topics and starting a thread; 23:20-24:13 notification preferences, bots, and alert words; 24:21-24:38 muting a noisy topic; 25:34-27:35 groups/invites.
- **Behavior demonstrated:** messages are addressed to a stream plus topic; topic-specific muting and alert words control attention; bots react to scoped messages; self-hosting and invitations are shown.
- **Problem addressed:** mixed conversations and broad notification streams.
- **Strengths:** topics are first-class addressing metadata; granular attention controls; self-hosted operation.
- **Weaknesses:** 2019 UI is stale; a general technical setup tour gives little evidence of adoption or readability; agent behavior is basic bot/integration behavior.
- **Product implication / confidence:** require a durable subject/context at the moment of posting, but avoid exposing infrastructure complexity or relying on bots as agents. **Moderate, UI details time-limited.**

### V6 — Zulip practitioner introduction

- **Direct link:** [Zulip Tools Trial 2026 — Intro to Zulip](https://www.youtube.com/watch?v=HZr7TSLlQy8)
- **Creator / date:** CSCCE, presented by Philip Durbin / 2026-01-23
- **Relevant timestamps:** 2:37-3:19 channels/topics/DMs; 3:19-3:55 reading-first philosophy; 4:01-6:28 inbox and reading strategies; 6:28-8:13 compose/reply friction; 8:13-8:42 moving messages to repair topic mistakes.
- **Behavior demonstrated:** topics appear in the main reading flow and inbox; users selectively read or mark topics read; messages can be moved after a routing mistake.
- **Problem addressed:** later readers must reconstruct mixed chat; high-volume organizations need to select relevant conversations.
- **Strengths:** current practitioner evidence; directly contrasts reading optimization with writing optimization; repairable structure reduces fear of mistakes.
- **Weaknesses:** presenter explicitly finds the hidden compose/reply affordances confusing and says other apps are easier to write in.
- **Product implication / confidence:** structure should optimize readers without hiding the composer; make misclassification cheap to repair. **High.**

### V7 — Mattermost Channels 101

- **Direct link:** [Mattermost Channels 101](https://www.youtube.com/watch?v=zC3XRzeMMPs)
- **Creator / date:** Mattermost / 2023-01-16
- **Relevant timestamps:** 0:05-0:37 channel navigation and categories; 0:37-0:52 collapsed replies and global threads view; 0:52-1:01 per-channel/thread notifications; 1:16-1:24 messages/files search; 1:29-1:38 commands and integrations.
- **Behavior demonstrated:** conventional message channels with collapsed reply threads, a cross-channel threads view, notification controls, search, calls, and slash commands.
- **Problem addressed:** channel noise and fragmented thread following in a self-hostable team messenger.
- **Strengths:** cohesive standard collaboration baseline; threads inbox and self-hosted positioning.
- **Weaknesses:** thread remains subordinate to a message and side-view model; extremely short official overview; no evidence of post-first or native agents.
- **Product implication / confidence:** self-hosting and familiar chat are not enough differentiation; avoid reproducing a message-rooted thread inbox as the main model. **High behavior / Limited evaluation.**

### V8 — Ubuntu Discourse practitioner talk

- **Direct link:** [How your team can get more from Ubuntu Discourse](https://www.youtube.com/watch?v=NJ5z0qBtkB4)
- **Creator / date:** Ubuntu OnAir, presented by Aaron Rainbolt / 2022-12-14
- **Relevant timestamps:** 1:18-2:01 converting public topics to private discussions and the “unanswered” appearance; 2:56-4:14 announcement lifecycle and slow mode; 5:33-6:26 unlist versus immutable archive; 6:28-8:25 category/tag governance.
- **Behavior demonstrated:** moderators change visibility, close/slow discussions, move announcements, archive historical topics, unlist irrelevant material, and govern tags.
- **Problem addressed:** durable forums accumulate stale, sensitive, miscategorized, and high-conflict content.
- **Strengths:** mature lifecycle/moderation primitives; distinguishes current, superseded, hidden, and historically immutable material.
- **Weaknesses:** considerable curator labor and taxonomy knowledge; presenter notes too many categories create a long-term problem; forum workflow can feel formal.
- **Product implication / confidence:** adopt explicit lifecycle and moderation states, but automate reminders and keep taxonomy small. **High.**

## Required source ledger

| Source | Type | Date | Observation | Evidence strength | Product implication | Confidence |
|---|---|---:|---|---|---|---|
| [Theo proposal](https://www.youtube.com/watch?v=wEAb0x3wTRc&t=2195s) | Video, primary proposal | 2026-06-22 | 39:58-40:17 defines posts between channels and threads, with threads as a sub-primitive usable by humans and agents. | Strong | Model post and thread separately; a renamed message is insufficient. | High |
| [Theo proposal](https://www.youtube.com/watch?v=wEAb0x3wTRc&t=2195s) | Video, primary proposal | 2026-06-22 | 37:15-38:18 active old threads disappear; desired app resurfaces them, supports targeted replies, branching, and agent investigation. | Strong | Activity resurfacing, reply ancestry, and bounded agent runs are core. | High |
| [Theo proposal](https://www.youtube.com/watch?v=wEAb0x3wTRc&t=2195s) | Video, primary proposal | 2026-06-22 | 38:18 explicitly asks for infinite nesting. | Strong | If UI renders shallowly, preserve deeper logical ancestry and document the divergence. | High |
| [Alcreon clip](https://www.alcreon.com/clips/weab0x3wtrc-clip-weab0x3wtrc-03) | Transcript clip/index | 2026-06-22 | Independently indexes the “threads are the sub-primitive on a post” claim. | Moderate | Useful transcript cross-check, not a substitute for full segment review. | High |
| [Meta Workplace discontinuation](https://about.fb.com/news/2021/10/workplace-fifth-birthday/) | Official announcement | 2024-05-14 update | Normal Workplace use ended 2025-08-31; read-only data access ended 2026-05-31. | Strong | Portability and durable ownership matter; Theo's shutdown context is accurate in substance. | High |
| [Slack Dev Day 2026](https://www.youtube.com/watch?v=AD1fsM-1NKQ) | Video, official demo | 2026-06-17 | Agents are scaffolded, scoped, installed, mentioned in threads, and connected to external tools. | Strong for behavior | Agent identity plus a mention is already available elsewhere; design explicit run/approval state. | High |
| [Working with AI and agents in Slack](https://www.youtube.com/watch?v=Rt_-zeeZdSo) | Video, official demo | 2025-01-13 | Search answers cite artifacts; long threads get summaries; selected channels get daily recaps. | Strong for behavior, limited claims | Give summaries provenance and direct expansion; structure should prevent overload before summarization. | High |
| [Discord Forums walkthrough](https://www.youtube.com/watch?v=Q8l8Bmq-7mE) | Video, independent walkthrough | 2022-09-23 | Forum channels contain titled posts with chat-like threads, tags, guidelines, and permissions. | Moderate | Social post creation can remain low-friction; optional forum silos are not enough. | High behavior |
| [Zulip self-hosted walkthrough](https://www.youtube.com/watch?v=hMvvqrUeNvw) | Video, independent walkthrough | 2019-08-24 | Stream+topic addressing and topic muting contain context and attention. | Moderate; dated | Use bounded subjects and granular follow/mute; validate against current docs. | Medium-High |
| [Zulip Tools Trial](https://www.youtube.com/watch?v=HZr7TSLlQy8) | Video, practitioner walkthrough | 2026-01-23 | Reading-first inbox succeeds, but hidden composer/reply affordances confuse a new user; messages can be moved to repair errors. | Strong qualitative | Optimize reading without increasing posting friction; make routing repairable. | High |
| [Mattermost Channels 101](https://www.youtube.com/watch?v=zC3XRzeMMPs) | Video, official overview | 2023-01-16 | Collapsed reply threads plus a global threads view reduce main-channel noise but remain message-rooted. | Strong behavior, limited depth | Familiar baseline, not the desired post-first model. | High |
| [Ubuntu Discourse talk](https://www.youtube.com/watch?v=NJ5z0qBtkB4) | Video, practitioner talk | 2022-12-14 | Moderators manage privacy, slow mode, announcements, unlisting, archives, categories, and tags. | Strong qualitative | Posts need lifecycle/moderation without requiring constant manual taxonomy gardening. | High |
| [Zulip: Introduction to topics](https://zulip.com/help/introduction-to-topics) | Official documentation | Current; accessed 2026-07-11 | Every channel conversation is labeled by topic; topics appear in the main view, recent conversations, inbox, and sidebar rather than a cramped thread panel. | Strong | Closest reading-first structure; post-first product needs equally strong rediscovery with lower compose friction. | High |
| [Discord Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ) | Official documentation | Updated 2024-10-24 | Posts prevent burying/talking over; roles, required tags, list/gallery layouts, inactivity hiding, dedicated search, and filtering are supported. | Strong | Discord already covers much of post-first community structure; differentiation must include work state and native agents. | High |
| [Discord forum announcement](https://discord.com/blog/forum-channels-space-for-organized-conversation) | Official product announcement | 2022 | Discord positions forums as organized, persistent conversation inside an otherwise real-time server. | Moderate; marketing | A hybrid chat/post product is proven feasible, but outcomes need independent validation. | High intent |
| [Twist](https://twist.com/) | Official product site | Current; accessed 2026-07-11 | Channels contain async threads; inbox gathers relevant thread activity; product suppresses presence pressure and broad notification dots. | Moderate; marketing | Twist is a major redundancy risk and must be studied before claiming novelty. | High intent |
| [Twist: What is Twist?](https://twist.com/help/articles/what-is-twist-aTA4QrqG) | Official documentation | Current; accessed 2026-07-11 | Workspace → channel → thread → comment; updated threads jump to the top; inbox tracks created/commented/tagged threads; DMs are for immediate private talk. | Strong | Much of Theo's resurfacing and async hierarchy already exists. Differentiate with post/thread semantics, social legibility, and auditable agent runs. | High |
| [Twist Inbox](https://twist.com/help/articles/what-is-the-inbox-r2KEWZwI) | Official documentation | Current; accessed 2026-07-11 | Active/Done/Saved thread states make catch-up an explicit processing workflow. | Strong | Consider lightweight “needs attention/done” state without turning posts into tickets. | High |
| [Slack AI agents](https://slack.com/ai-agents) | Official product page | Current; accessed 2026-07-11 | Agents interact in channels, DMs, and threads; may use public conversation data and take actions such as creating channels, updating canvases, and sending DMs. | Moderate; marketing, with official capability detail | “Agent teammates” alone is not a differentiator; scoped access and action visibility are critical. | High capability |
| [Slack threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions-/slack.com) | Official documentation | Current; accessed 2026-07-11 | A thread is rooted in a message; replies may be sent back to channel; users follow threads via notifications and a Threads view. | Strong | Confirms Theo's criticized root-message/side-view model remains foundational. | High |
| [Slack search](https://slack.com/help/articles/202528808-How-to-search-in-Slack) | Official documentation | Current; accessed 2026-07-11 | Search spans messages/files/people/channels/canvases and supports thread, author, date, reaction, and conversation modifiers. | Strong | Competing search must be permission-correct and object-aware; rediscovery cannot rely on query syntax alone. | High |
| [Slack notifications](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications) | Official documentation | Current; accessed 2026-07-11 | Users can choose all activity versus mentions/DMs, schedules, Activity contents, VIPs, and keywords; thread messages do not trigger keyword notifications. | Strong | A unified priority surface needs explainable inclusion and gap-free rules across post/thread scopes. | High |
| [Linear AI Agents](https://linear.app/docs/agents-in-linear) | Official documentation | Current; accessed 2026-07-11 | Agents are app users installed by admins, scoped to selected teams, mentionable/delegable, and visible in contribution/activity views; a human remains responsible. | Strong | Adopt explicit human accountability, scoped installation, participant identity, and agent activity history. | High |
| [Linear agent interaction](https://linear.app/developers/agent-interaction) | Official developer documentation | Current; accessed 2026-07-11 | Agent sessions expose lifecycle states and semantic activities such as actions, prompts, final responses, and errors. | Strong | Treat a run as typed, inspectable state rather than a typing bot. | High |
| [Mattermost threaded discussions](https://docs.mattermost.com/end-user-guide/collaborate/organize-conversations.html) | Official documentation | Current; accessed 2026-07-11 | Users auto-follow participated threads, can follow a message before replies, and see recent followed threads in a unified inbox. | Strong | Pre-follow, unread filtering, and explicit follow state are useful; post activity should be easier to rediscover than a side inbox. | High |
| [Discourse trust levels](https://meta.discourse.org/t/discourse-trust-levels-a-detailed-explanation/396792) | Official product/community documentation | 2026-02-23 | Participation permissions can increase with demonstrated reading and constructive activity; high trust may later be lost or manually granted. | Strong | Community permissions can be progressive, but workspaces need predictable admin-defined roles and transparent reasons. | High |
| [Matrix public rooms and Spaces](https://www.matrix.org/docs/chat_basics/public-rooms/) | Official documentation | Updated 2025-12-11 | Spaces group rooms, but joining a Space does not automatically join every room; public room discovery and previews are separate. | Strong | Container membership must not silently grant all child access; make discovery versus membership explicit. | High |
| [Matrix Client-Server API](https://spec.matrix.org/unstable/client-server-api/index.html) | Protocol specification | Current unstable; accessed 2026-07-11 | Threads are event relations with server aggregation and history-visibility constraints; incomplete history can make aggregates incomplete. | Strong technical | Authorization must be applied before aggregation/search; federation/partial history complicates counts and summaries. | High |
| [Teams channel posts](https://support.microsoft.com/en-US/teams/teams-channels/send-or-reply-to-a-channel-message-in-microsoft-teams) | Official documentation | Current; accessed 2026-07-11 | Channels can use a Posts layout where new conversations have subjects and replies; moderators can restrict who starts conversations. | Strong | Theo's post-like surface is not novel by itself; interaction quality and agent context are the opening. | High |
| [Teams channel notifications](https://support.microsoft.com/en-us/teams/teams-channels/manage-channel-notifications-in-microsoft-teams) | Official documentation | Current; accessed 2026-07-11 | Users choose channel post/thread notifications and can follow all new threads without necessarily receiving Activity alerts. | Strong | Separate following from interruptive alerts. | High |
| [Reddit moderator capabilities](https://support.reddithelp.com/hc/en-us/articles/15484284113172-What-mods-can-do) | Official documentation | Updated 2025-01-20 | Moderators approve/remove, distinguish, pin, lock posts/comments, and choose default comment sort. | Strong | Post-first community primitives require granular moderation at both post and reply level. | High |
| [Facebook group membership](https://www.facebook.com/help/www/214260548594688) | Official documentation | Current; accessed 2026-07-11 | Public/private groups have distinct participation, membership approval, questions, invite links, and automatic admin criteria. | Strong | Social legibility must be paired with explicit visibility and participation policy; invite links must be revocable. | High |

## Cross-source conclusions

### Confirmed opening

The market does **not** lack structured conversations. Zulip labels every conversation, Twist uses channels/threads/comments and bumps updates, Discord Forums uses titled posts, Teams has channel posts, Discourse has mature topics, and Mattermost has a threads inbox. Slack and Linear also already present agents as teammates.

The narrower opening supported by the sources is a product that combines:

1. A socially legible post feed as the default team surface, not an optional forum channel.
2. Durable, bounded reply branches with low-friction composition and repairable structure.
3. Explainable resurfacing and catch-up optimized for readers.
4. Native agent participant identity, scoped installation, typed run state, approvals, and human accountability.
5. Decisions/files/tasks/context attached to the discussion without forum administration or project-management ceremony.

### Contradictions the product must resolve

- **Structure versus posting friction:** Zulip shows strong reading benefits and real compose confusion. Default the destination intelligently, keep title/body creation easy, and permit moderators/authors to move content later.
- **Resurfacing versus attention pressure:** Theo and Twist support bumping active old content; Slack/Teams expose granular follow/notification settings. Resurfacing in a feed should not imply an interruptive alert.
- **Autonomy versus control:** Slack demonstrates powerful action-taking; Linear preserves human responsibility and typed activity. Agents need scope, approval policy, visible action history, cancellation, and an accountable human.
- **Nesting versus readability:** Theo says infinite nesting; Facebook/Reddit-style depth becomes difficult on mobile. Preserve ancestry and branch focus while collapsing visual depth.
- **Durability versus maintenance:** Discourse demonstrates useful archive states but substantial curator work. Automate expiry prompts and keep lifecycle states few and reversible.

## Known limitations

- YouTube captions are auto-generated; timestamps and central meaning were checked, but non-anchor wording should not be published as verbatim quotation without audiovisual verification.
- V4, V5, V7, and V8 show interfaces from 2022 or earlier; current official docs were used to validate enduring behavior where possible.
- Vendor videos and marketing pages demonstrate intended behavior and capabilities, not adoption, reliability, or measured user outcomes.
- No inaccessible source was inferred.
