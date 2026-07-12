# User pain points in team communication

Research date: 2026-07-11

## Executive finding

The strongest opening is not “chat with AI.” It is a durable, low-ceremony boundary around a piece of work: a legible post, a small number of focused discussion threads, and explicit outcomes that remain attached to the conversation. Users repeatedly compensate for chat chronology by inventing headlines, forwarding messages to themselves, copying requests into task systems, maintaining separate decision docs, or creating triage channels. Those workarounds restore ownership and rediscovery, but at the cost of context switching and duplicate maintenance.

The evidence also argues against treating all chat as failed project management. Several experienced users explicitly say Slack is a communication tool, not an execution system, and that trying to make it a filing cabinet or ticket tracker is the cultural mistake. The product therefore should not force every conversation into a task workflow. It should let a casual conversation remain casual while making the transition to a durable decision, task, or resolved thread nearly effortless and visible to the group.

The agent-native opportunity is similarly bounded. Public, inspectable agent use helps teams learn together, and shared organizational context can compound. But autonomous agents that listen everywhere, jump into conversations, or act across tools without clear scope introduce noise, cost, privacy, prompt-injection, and accountability problems. An agent should enter through an explicit mention, delegation, or subscribed event; receive the smallest authorized post/thread context; expose its run and tool actions; and require approval for consequential side effects.

## Method and limitations

- Official documentation was used only to establish intended product behavior. It is not treated as evidence that a feature works well.
- Reddit was accessible without authentication on 2026-07-11. For every counted discussion, the original post and visible comments were read. Deleted, moderated, promotional, or suspicious contributions are called out rather than generalized.
- Direct `x.com` page extraction returned empty bodies for several supplied links. Text was verified where possible through X's official oEmbed endpoint, search-indexed X pages, and public post-metadata mirrors. X replies and full surrounding conversations were not consistently recoverable. Accordingly, X evidence is mostly a lead or corroborating practitioner statement, not a measure of prevalence.
- Engagement counts were ignored as proof. Reddit and X are qualitative, self-selected evidence.
- Posts from vendors or people launching a product are tagged as directional or low confidence. They can reveal a design hypothesis, not validate demand.
- Dates below are the post dates exposed by the source where available. “Accessed” means the page was checked on 2026-07-11.

## Prioritized pain map

| Priority | Pain | What users do now | Root cause | Product implication | Confidence |
|---|---|---|---|---|---|
| P0 | Requests and action items disappear in chronology | Star/save, mark unread, add reminders, copy into Asana/Linear/text, create triage channels | Chat has no shared owner/status queue | Extract a task in place; preserve source discussion; show owner/status in post and personal inbox | High |
| P0 | Decisions and rationale disappear | Search vague memories, maintain a wiki, copy summaries into docs, ask people again | The final choice and rejected alternatives are not first-class | Decision outcome with author, timestamp, rationale, dissent, and source thread; editable but auditable | High |
| P0 | Threads are hard to scan and rediscover | “Headline” root messages, self-DM keywords, forward to channel, manual summaries | A thread is anchored to an arbitrary message and previews do not show enough context | Require/derive a useful title, show a meaningful preview and outcomes, support stable permalinks and saved views | High |
| P0 | Notification pressure creates anxiety and missed work | Mute most channels, DND blocks, scheduled checks, rely on mentions, abandon inbox zero | Unread activity conflates relevance, responsibility, and urgency | Separate ambient unread from “needs me”; default to follow/mention/assignment semantics; offer finite catch-up | High |
| P0 | DMs trap institutional knowledge and overload brokers | Forward DM to a public channel, create support/triage channels, document repeated answers | Asking privately is socially easier; shared intake has no friction advantage | Make “move to post” consensual and fast; preserve access rules and attribution; suggest public destination without exposing private text | High |
| P0 | Agent scope and accountability are unclear | Put bots only in selected channels, use confidence thresholds, add dashboards, human approval, separate memory files | A Slack bot often inherits a broad conversational surface and opaque tool authority | Explicit installation scopes, per-space access, mention/delegation modes, run ledger, cancellation, approval gates, non-human identity | High |
| P1 | Structure improves recovery but adds posting friction | Use chat for quick talk and tickets/docs for durable work; abandon structured tools | Titles, categories, fields, and status choices feel formal for small exchanges | Progressive structure: title/body first; outcomes appear when needed; sensible defaults; no required taxonomy for ordinary posts | High |
| P1 | Mobile hides reply context and increases extra taps | Avoid forums, use web instead of mobile apps, expand/collapse comments manually | Narrow screens expose the cost of side panels, deep trees, and nested containers | One visible reply level, sticky parent context, tap targets that do not destroy place, outcome summary before history | High |
| P1 | Self-hosting promises control but creates operational/adoption costs | Stay on Slack/Discord, tolerate feature limits, bridge networks, use web clients | Push notifications, mobile polish, identity setup, retention, upgrades, and network effects are hard | Self-hostable backend is not sufficient; hosted-quality clients, push, import, and predictable licensing are adoption features | High |
| P1 | Public knowledge and private work conflict | Prefer public channels, create private spaces, copy sanitized summaries | Publicity helps learning/search; sensitive work needs hard boundaries | Authorization before indexing and previewing; explicit audience; safe promotion from private to shared; no inferred cross-space retrieval | High |
| P1 | Agent output can become ambient noise | Require mentions, confidence gating, dedicated bot channels, disable proactive replies | Agents optimize for helpfulness without bearing interruption cost | Quiet-by-default agents; collapsed progress; post one result, not narration; user/space rate and cost limits | Medium-high |
| P2 | Search depends on remembering the original vocabulary | Add keywords to self-DMs, use external docs, ask colleagues | Messages lack durable labels, titles, and normalized outcomes | Search across posts, threads, messages, tasks, decisions, files, people; outcome-aware filters; permission-safe previews/counts | High |
| P2 | Forums feel formal or kill momentum in small groups | Keep general chat channels; use forums only for large topics | An extra click and a compose form are costly for lightweight social exchange | Spaces may mix post-first work and lightweight chat, but post feed remains primary; fast composer and conversational presence matter | Medium-high |
| P2 | Tool fragmentation creates duplicate notifications and stale state | Link Slack to Asana/Confluence/Notion/Zapier, manually copy context | Each system owns a different primitive; integration is a lossy dual write | Keep outcome and discussion together; external sync must be explicit, idempotent, and show source-of-truth status | High |

## Core contradictions and behavioral resolutions

### Users want structure but resist forms

The Slack “headlining” discussion shows users independently reinventing topic titles to reduce channel noise, while another user finds terse headlines worse because the useful context is hidden behind a click. Discord forum users similarly value discoverability but say the extra click can kill momentum in a small community. The resolution is not mandatory metadata. A post should be understandable from its title plus a visible body/preview; tags, status, task fields, and decision fields should be optional enhancements. If the system proposes a title or outcome, the author can accept or edit it without blocking publication.

### Users want fewer notifications but fear missing obligations

Muting everything is effective until someone expects an unmentioned message to be read. “All activity” and “needs me” must be different products. Ambient activity belongs in space unread state and catch-up summaries. Mentions, assignments, approval requests, and followed-thread replies belong in the inbox. An explicit urgent path should be rare, permissioned, and rate-limited.

### Users want durable knowledge without maintaining a wiki

The common workaround is to move the “important part” into Confluence, Notion, Google Docs, Asana, Linear, a calendar, or a private self-message. Commenters acknowledge that this can be correct past a complexity threshold, but the copying and taxonomy work are costly. Durable outcomes should be created from the discussion, link back to the exact messages, and appear in a workspace-level decision/task view. This does not eliminate long-form docs; it eliminates the requirement to restate why a decision exists.

### Users want autonomous agents but demand control

Practitioners report value when an agent searches authorized history, drafts artifacts, creates issues, or works in a shared thread. The same sources add hooks, approval stages, isolated subagents, confidence thresholds, or per-channel installation. Default autonomy should therefore be read-only or reversible. External messages, destructive changes, permission changes, and money-moving actions require preview/approval. Every run needs a durable actor, input scope, tool log, cost, final status, and retry semantics.

### Users want reply context but dislike deep trees

Reddit makes parallel sub-conversations possible, yet users report losing the parent context on mobile, struggling with collapsed branches, and being unable to return from a notification to the relevant discussion. Slack's single side thread is shallower but hard to rediscover. The product should support multiple named threads under one post, but only one contextual inline-reply level inside a thread. Replies should always show a compact parent reference and a stable “view in context” path.

### Users want async communication but still need immediacy

Zulip and Twist demonstrate that topic-first async communication is already viable. Discord users counter that forums can kill momentum, and other users value Slack huddles or instant back-and-forth. A post-first system must retain presence, quick replies, optimistic sends, typing only when useful, and a secondary DM path. It should not use real-time animation to turn every post into an interruption.

## Workarounds worth productizing

| Observed workaround | What it restores | Product behavior to adopt | What not to copy |
|---|---|---|---|
| Headline a Slack root, put detail in first reply | Topic scanability | Title plus visible body/preview; optional AI title suggestion | Empty/cryptic root that hides the actual request |
| Forward a message/thread to yourself with keywords | Personal rediscovery | Save with note/tags; index note and source; show saved outcome state | A second opaque inbox with no shared ownership |
| Copy request to Asana/Linear/list | Owner, priority, status | Create task from selection; keep bidirectional source link and visible assignee | Silent duplicate whose status diverges |
| Create a public intake/triage channel and rotate duty | Shared ownership and lower DM load | Space-level intake post type, queue view, SLA/owner, rotation integration | Turning every space into a support ticket queue |
| Post TL;DR/BLUF at top of a thread | Relevance scanning | Author/agent-editable thread summary with provenance and timestamp | Summary that overwrites disagreement or pretends certainty |
| DND plus scheduled inbox checks | Focus | Digest/catch-up windows, notification schedules, finite “needs me” queue | Expecting users to manually mute hundreds of spaces |
| Put agent in selected channels only | Context and permission boundary | Per-space scopes and explicit invocation/subscription modes | Workspace-wide read because installation was approved once |
| Human approval between agent research and execution | Trust boundary | Prepare/approve/commit run state and visible diff | Chat message saying “done” without an execution receipt |
| Append decisions and failures to a knowledge store | Compounding learning | Outcome records and append-only activity linked to source discussion | An agent-only memory that humans cannot inspect or correct |

## Adoption barriers

1. **Network effect and switching cost.** In self-hosted discussions, the most common rejection is not technical: everyone already uses Discord or Slack. Splitting communication across tools is worse than tolerating a flawed incumbent.
2. **Behavior change.** Zulip's topic model is often praised after adoption but described as initially confusing or “corporate.” A novel primitive must be taught through seeded content and immediate utility, not onboarding prose.
3. **Mobile and push reliability.** Slow clients, inconsistent thread unread state, reliance on a vendor push gateway, or notification limits are deal-breakers even for technically capable self-hosters.
4. **Operational burden.** Matrix identity/encryption setup, retention storage growth, upgrades, and admin tooling shift labor onto the adopter.
5. **Pricing and edition uncertainty.** Users hesitate when retention, roles, push, guest access, or history are paywalled or free-edition terms change.
6. **Migration fidelity.** Discord forum users noted that channel history could not simply become forum posts. A replacement must preserve permalinks, authorship, timestamps, files, and access boundaries or clearly scope what cannot migrate.
7. **Social tone.** “Corporate” or ticket-like structure is rejected by friend groups, student organizations, and small communities even when the information model is superior.
8. **Trust and privacy.** Agent search across private messages, broad connectors, unreviewed actions, or unclear training/retention terms can stop adoption before usability matters.
9. **Tool overlap.** Teams already have Slack plus Linear/Asana/Notion. A new platform must remove a recurring handoff or failure, not merely add a nicer feed.
10. **Culture cannot be patched by UI.** If leaders expect everyone to read everything, use DMs for intake, or refuse to record decisions, no thread model will solve the behavior alone. The product can make the desired behavior cheaper and make expectations explicit.

## X research ledger

Fifteen substantive or potentially substantive X posts were reviewed. Ten are useful at medium or higher confidence; five are retained as directional/low-confidence evidence because they are launches, marketing, or lightly supported analysis. Direct post bodies were not reliably available from `x.com` itself, and reply trees could not be audited consistently. No claim below depends on engagement counts.

| # | Post | Direct experience / observation | Disagreement or caveat | Evidence use | Confidence |
|---:|---|---|---|---|---|
| 1 | [Simon Willison: Shopify River is public in Slack](https://x.com/simonw/status/2053529689122328947), 2026-05-10 | River being limited to public channels lets coworkers learn agent prompting by watching one another; compares it with Midjourney's Discord launch | Public-only improves learning but is unsuitable for sensitive work; underlying Shopify implementation was not independently inspected here | Strong support for inspectable, social agent use and explicit public/private boundaries | High for the statement; medium for inferred product outcome |
| 2 | [Ashton Teng: Why Slack needs to be rebuilt for AI agents](https://x.com/ashtonteng/status/2057997426334859722), 2026-05-23 | Article preview says the team placed OpenClaw/Claude Code in Slack channels and connected broad tools; argues for end-to-end agent-oriented architecture | Full X article body was not recoverable, so only title and preview are evidence; Quinn Leng's supplied link is a pointer, not a separate substantive source | Lead supporting the thesis that bolted-on bots inherit Slack's boundaries; do not quote beyond preview | Medium-low |
| 3 | [Eyal Toledano: Context Graphs Can't Organize Knowledge That Was Never Captured](https://x.com/EyalToledano/status/2008965413162430508), 2026-01-07 | Follows a feature from spec through Slack clarification and an unrecorded call; the shipped rationale ends up in a few people's heads | Author builds an AI-native workspace, so the framing is commercially aligned; the scenario is nevertheless specific and falsifiable | Strong articulation of capture failure: organize decisions at creation time, not only through later search | Medium-high |
| 4 | [Karri Saarinen: shared organizational intelligence](https://x.com/karrisaarinen/status/2053946611395653931), 2026-05-11 | Reports Linear Agent working across Linear, Slack, GitHub, support tools and code; cites team use, prompt improvement folded back into shared systems, and agent-opened PRs | Linear CEO promoting Linear; quantitative claims were not independently verified | Strong product pattern: human owner remains in loop, shared context compounds, work/action stays connected | Medium |
| 5 | [Joey Wang: Harvey's Spectre](https://x.com/ZongZiWang/status/2041579897571963272), 2026-04-07 | Says EPD context is fragmented and Spectre brings Slack/web requests into a collaborative cloud-agent platform | Linked article was not fully analyzed here; internal tool success is self-reported | Supports multi-entry agent work with one inspectable collaboration surface | Medium |
| 6 | [Pranay Mohan: monorepo collaboration tension](https://x.com/pranaymohan/status/2017755282743365924), 2026-01-31 | Notes shared context helps agents at small scale but high agent commit velocity creates contention; quotes Mitchell Hashimoto's stronger warning | Software-repository coordination is adjacent, not team-chat UX | Useful contradiction: more shared context and more agents also create concurrency and attention costs | Medium |
| 7 | [Daniel Carpenter: governance for an agent squad](https://x.com/dcarps14/status/2018484491967463904), 2026-02-02 | Describes approval for hiring/firing, a write-down/read-up chain of trust, append-only working files, and keeping hierarchy flat because it adds latency/context loss | Early “Day 1” system and self-authored policy, not a long-term evaluation | Supports explicit authority, approval, audit, and minimal hierarchy | Medium-low |
| 8 | [Kaxil Naik: four months directing agents](https://x.com/kaxil/status/2037503513350005134), 2026-03-27 | Reports agents searching Slack, using email/calendar/todos, writing meeting notes and PR reviews; uses hooks, restricted subagents, and human code review | Self-report and unusually advanced user; not representative of normal adoption | Strong evidence that agent value comes from harness, permissions, review, and cross-tool context rather than chat persona | Medium-high |
| 9 | [Olivia Kory: AI on a client-facing team](https://x.com/oliviaakory/status/2035422533218910676), 2026-03-21 | Describes using call context, experiment results, trackers, Slack history and a knowledge base for briefs and client prep; says high-judgment advice remains human | Positive showcase and recruiting post; no failure rate or permission model given | Supports agents as context assemblers and draft producers, not autonomous decision owners | Medium |
| 10 | [glitch_: swarm and Hermes](https://x.com/glitch_/status/2033175616485286254), 2026-03-15 | Says experiments failed when agents lacked team context; implements shared knowledge, isolated execution, an approval phase, and append-only result logs | Hackathon build, promotional language, incomplete long-term validation | Directional evidence for bounded roles, shared learning, approval and durable run records | Low-medium |
| 11 | [Marty Ryze: local-first persistent agent stack](https://x.com/martyryze/status/2026326256162054243), 2026-02-24 | Gives an unusually candid account of crashes, config wipes, manual routing, write-ahead memory, archives, health checks and multi-channel presence | Elaborate persona/product narrative; claims not independently verified | Useful failure catalog: persistence, recovery, configuration integrity, cost, and explicit publication boundary matter | Low-medium |
| 12 | [Blake Anderson: Core AI-native workspace](https://x.com/blakeandersonw/status/2038276867464061056), 2026-03-29 | Launch thesis combines Slack, Linear and Notion around centralized context for agents | Launch post, not evidence of user success; very close to the proposed product thesis | Competitive signal that “centralized context for agents” is already crowded; differentiation cannot be copy alone | Low |
| 13 | [Kath Korevec: agents should meet users across chat surfaces](https://x.com/simpsoka/status/2034738664492945801), 2026-03-19 | Observes chat spans Slack, Discord, Teams, GitHub, Linear, email and messaging; quotes Vercel's cross-platform agent thesis | Opinion/positioning, not direct measured experience | Directional: portability and channel reach matter, but a product cannot assume it owns every conversation | Low |
| 14 | [Tibo: Slackbot that auto-logs key decisions](https://x.com/tibo_maker/status/1953750606738309211), 2025-08-08 | Lists auto-logging Slack decisions among small, clear pain points observed in maker workflows | Idea list and monetization framing; no implementation or user study | Weak corroboration that decision capture is recognized, not validation of a solution | Low |
| 15 | [Slack: the hidden knowledge crisis](https://x.com/SlackHQ/status/1905344106739515622), 2025-03-27 | Slack itself frames enterprise search as a response to workers not finding needed knowledge | Pure product marketing and promotes retrieval after the fact | Competitive positioning only; reinforces that search alone is the incumbent answer we must exceed | Low |

Rejected from evidence: Quinn Leng's supplied post was only a link to Ashton's article; an OpenClaw SEO article contained aggressive promotion and unsupported safety claims; a technical Slack “deep dive” asserted internal implementation details without primary sourcing; several search results were generic AI launch amplification. They are not counted as user evidence.

## Reddit discussion ledger

Twenty-four discussions were reviewed; the first twenty-one contain enough visible original/comment context to use. The last three are useful cautions about contamination or narrower UX. Comments recommending a named product were treated as potentially promotional when the commenter disclosed affiliation, repeated links, or provided no tradeoff.

| # | Discussion | Complaint / requested behavior | Workaround, disagreement, or rejection | Product implication | Confidence |
|---:|---|---|---|---|---|
| 1 | [Structured chat with title, tasks, files and thread](https://www.reddit.com/r/selfhosted/comments/1stlcvy/has_anyone_built_a_structured_chat_server_that/) | Wants one permanent atomic unit; original post is deleted, but comments discuss the model | Commenters suggest Zulip, Mattermost, Rocket.Chat, GitHub/Linear, Notion/Obsidian; one argues separating discussion and decision is cleaner; OP-like replies appear promotional for “capsules” | Strong disagreement: integration may be better than one overloaded object; evidence is limited because OP was deleted | Low-medium |
| 2 | [Missing action items in busy Slack threads](https://www.reddit.com/r/Slack/comments/1shlke3/missing_action_items_in_busy_threads_is_the/) | Requests disappear unless immediately starred/reminded; chronology conflicts with prioritized execution | Slack Lists/workflows, Zapier, Asana, copy/paste to private todo, intake/triage. Multiple product plugs are present. A strong dissent says the company is using a telephone as a filing cabinet | In-place extraction plus shared ownership; do not pretend ordinary chat is a ticket system | Medium-high after discounting promotion |
| 3 | [Keeping track of important Slack threads/messages](https://www.reddit.com/r/Slack/comments/15zwygt/how_do_you_keep_track_of_important_threads_and/) | “Save for later” becomes an unwieldy mixed folder; retracing steps wastes time | Asana/docs/calendar, Zapier, self-DM links with remembered keywords, search, reminders. One user says search usually works. OP notes Confluence has time/context-switch cost | Saved items need notes/type/status; search needs semantic/outcome context; moving information must preserve source | High |
| 4 | [Team “headlining” Slack threads](https://www.reddit.com/r/Slack/comments/1c1o15w/my_team_has_started_headlining_all_their_threads/) | Terse root headlines hide the actual request, forcing a click into every thread | Better BLUF/TL;DR headlines, forward the real message back to channel. Dissent: the team has reinvented forums and titles are useful when written well | A title is valuable only with a visible substantive preview; scanning must not require opening every thread | High |
| 5 | [Engineering manager feels like a Slack monkey](https://www.reddit.com/r/ExperiencedDevs/comments/1c5nvfb/engineering_managers_anyone_else_feels_like_a/) | ~20 DMs plus ~10 tagged threads create continuous triage, context switching and burnout | Delegate, shared intake channel, rotating duty, SLA, ticket triage. Disagreement: communication brokerage is the manager's job; OP says requests still route through them | Reduce private routing; make team-visible intake/ownership cheap; product cannot erase role/culture load | High |
| 6 | [Discord Forums versus channels](https://www.reddit.com/r/discordapp/comments/1fcea1i/for_those_experienced_with_discord_forums_why_not/) | Asks whether one forum can replace many channels | Forums improve thread discoverability and declutter large communities; extra click kills momentum in small groups; forums inherit thread limits, including 1,000 participants; migration from channels is poor | Post-first needs a fast lightweight mode, strong discoverability, and scale/migration paths | High |
| 7 | [Self-hosted alternatives to Slack/Discord for personal use](https://www.reddit.com/r/selfhosted/comments/1jpvjf7/are_you_happy_with_alternatives_to_slack_and/) | Privacy, feature downgrades and history limits motivate switching; friend adoption is the main barrier | Mattermost praised for deployment and modern basics but criticized for mobile bugs, retention/pricing; Zulip feels corporate; Matrix setup confuses users | Reliability, mobile and adoption beat architectural purity; predictable retention/licensing matter | High |
| 8 | [Agents as Slack bots](https://www.reddit.com/r/LangChain/comments/1m7mxtc/how_building_agents_as_slack_bots_leveled_up_our/) | Builder reports collaborative prompting, ticket creation and shared learning in threads | Bots proactively enter selected channels based on a confidence threshold; comments question cost and trigger criteria; post promotes the builder's platform | Shared visibility is valuable, but proactive listening needs clear scope, cost and invocation controls | Medium; self-promotional |
| 9 | [Looking for a self-hosted Slack alternative](https://www.reddit.com/r/selfhosted/comments/1l29dy7/looking_for_a_selfhosted_slack_alternative/) | Small team wants privacy, Docker and low resource use | Mattermost praised; Zulip threading praised but initial UX/adoption compared to “free tooth extraction”; commenters challenge possible Zulip promotion and notification pricing | Topic models require exceptional onboarding and demonstrated immediate benefit | Medium-high |
| 10 | [Zulip versus Mattermost for a nonprofit](https://www.reddit.com/r/selfhosted/comments/1kjp3d8/zulip_vs_mattermost/) | Needs stable communication for students/volunteers; asks about cross-organization channels | Mattermost mobile described both as slow and now fine; Zulip praised for topics; one commenter says Slack's free offer is not worth replacing because users want stability | Evidence conflicts by version/device; mobile must be tested, not inferred from architecture | Medium |
| 11 | [Slack alternatives in 2026](https://www.reddit.com/r/selfhosted/comments/1qf0d9e/slack_alternatives/) | Wants good web and mobile apps for ~20 Slack-trained users | Zulip easy/web good/threads liked but mobile problems; Element OIDC setup difficult; Mattermost suggested | Identity and mobile setup are switching blockers for ordinary teams | Medium |
| 12 | [Self-hosted Discord replacement discussion for 2026](https://www.reddit.com/r/selfhosted/comments/1r08bd8/lets_get_a_selfhosted_discord_replacement_thread/) | Seeks control without losing modern mobile behavior | Network/mobile design rules out IRC-like persistence; Zulip push may rely on SaaS; Mattermost free-tier changes concern users; Matrix/Element admin UI criticized | “Self-hosted” must disclose push dependencies and edition constraints; admin UX is part of product quality | Medium-high |
| 13 | [Slack alternative for a 100-person company](https://www.reddit.com/r/selfhosted/comments/1ipymq8/slack_alternative_for_100_pax_company/) | Needs retention, webhooks, notifications, low cost | Mattermost retention paywall, Zulip push limit, Matrix complexity, other free-tier caps | Retention, notifications and predictable scale pricing belong in adoption planning | Medium |
| 14 | [Self-hosting Matrix notifications](https://www.reddit.com/r/selfhosted/comments/1neyxld/self_hosting_matrix_notifications/) | Questions whether mobile push still requires a third party, undermining independence | Commenter says Matrix is less mature and recommends Mattermost/Rocket.Chat for corporate chat | Explain trust boundaries and push architecture; do not market “self-hosted” as absolute independence | Medium |
| 15 | [Why Slack/Discord alternatives still do not work](https://www.reddit.com/r/selfhosted/comments/1q5pebo/anyone_else_feel_like_slack_discord_alternatives/) | Asks what remains broken after switching | Leading answer says network effect, not technology, is decisive; people bridge multiple services rather than move all contacts | Switching requires a compelling group-level wedge, import, invites and interoperability—not a feature checklist | High for qualitative barrier |
| 16 | [Handling constant Slack, Teams and email inflow](https://www.reddit.com/r/productivity/comments/hwf3ty/how_to_handle_the_constant_inflow_of_slack_email/) | Unread counts and interruption create anxiety and prevent focus | DND, close apps, scheduled communication checks, collect actions into one system; some tool promotion in comments | Support focus windows and finite action inbox; no product can make unlimited inflow healthy | Medium-high |
| 17 | [Understanding Reddit context for replies](https://www.reddit.com/r/help/comments/1euyznk/trying_to_understand_reddit_comment_threads_for/) | Notification opens a reply without enough parent context; user feels participation goes into a void | Repeatedly navigate to parents, losing child position on long branches | Stable “view in context,” compact ancestry, and return position are mandatory on mobile | High for UX report |
| 18 | [Following a Reddit thread](https://www.reddit.com/r/help/comments/1chqdeg/how_do_i_follow_a_thread_ie_to_be_notified_of_new/) | Desktop follow option appears/disappears across versions; mobile/web behavior differs | Use app Subscribe, old/classic site plus RES, or a particular web surface | Following must be consistent across clients and separate from participation | Medium |
| 19 | [Keeping context in long Reddit comment sections](https://www.reddit.com/r/help/comments/121u9v7/how_do_i_not_get_lost_in_long_comment_sections/) | Deep third/fourth-level replies make it hard to remember what each branch answers, especially on phone | Collapse read branches, use parent-jump in third-party apps/RES; commenter says mobile experience is poor | Avoid arbitrary depth; keep parent reference visible; make read/collapse state predictable | High |
| 20 | [Expanding all Reddit comments by default](https://www.reddit.com/r/help/comments/1dgfd6q/how_to_expand_all_comments_by_default/) | “More replies” hides a participated-in exchange and notification links switch between site versions | Use a deprecated alternate web version; manually expand branches | Hiding context to simplify the screen can destroy rediscovery; cross-client links must preserve target | Medium-high |
| 21 | [Discourse project communication confusion](https://www.reddit.com/r/alignerr/comments/1hzw96x/how_do_we_navigate_project_communication/) | User cannot tell category/topic membership or discover restricted project discussions; dislikes mobile experience | Manually searches, subscribes after finding threads | Formal structure fails if membership and notification state are invisible; onboarding must be in-product | Medium |
| 22 | [Slack management in very large organizations](https://www.reddit.com/r/ProductManagement/comments/1ulag00/slack_management/) | Hundreds of channels and dozens of unread messages make management a job | Mute, sections, mentions-only contract, recaps. Some users praise Slack's reminder/link/notification controls; another says this is organizational culture | Preserve strong incumbent controls; avoid promising unread zero; establish team communication contracts | Medium; very recent |
| 23 | [Agents that take actions, not just answer](https://www.reddit.com/r/LangChain/comments/1upv6qn/how_are_you_handling_ai_chatbotsagents_that_need/) | Action-taking agents fail on reliability, permissions, duplicate side effects and retrieval errors | Typed proposals, normal-code validation, risk classes, approval, execution ledger, idempotency, budgets, failure tests | This is the clearest implementation checklist for safe agent actions, but post is very recent and may contain synthetic/expert-marketing prose | Medium-low; use as checklist, not prevalence |
| 24 | [Async Slack burnout story](https://www.reddit.com/r/cscareerquestions/comments/1srh2fr/remote_cs_teams_async_slack_hell_or_productivity/) | Claims 24/7 guilt and boundary blur | DND/work hours and using task-native tools; comments identify the post as likely promotional/bot content | Do not count polished pain narratives without comment scrutiny; the workaround is corroborated elsewhere | Rejected as primary evidence |

## Evidence-backed product requirements

### Include

- Post title plus visible body/preview; never a title-only shell.
- Multiple named, bounded threads under a post with one level of contextual inline reply.
- One-click extraction of a task or decision from selected messages, with durable source links.
- Shared task owner/status and decision rationale/history visible in both post and filtered workspace views.
- A personal “needs me” inbox distinct from ambient unread activity.
- Following, saving with a note, reminders, mentions, assignments, and approval requests as separate concepts.
- Permission-safe search over posts, threads, messages, outcomes, files and authors; no unauthorized counts/previews.
- Explicit audience and a consensual “move private discussion to post” flow.
- Agents as labeled service identities with per-space scopes, explicit trigger modes, visible run state, cancellation and audit.
- Prepare/approve/commit for consequential agent actions; idempotency keys and final receipts.
- Mobile-first context: sticky post/thread identity, parent excerpt, stable back position, no deep indentation.
- Import/export and transparent push/retention architecture.

### Defer

- Autonomous agent listening across an entire workspace.
- Sophisticated agent-to-agent social graphs and hierarchical organizations.
- Full task-management replacement: dependencies, roadmaps, resource planning and portfolio analytics.
- Arbitrary cross-platform write-back; begin with links/webhooks and one clearly authoritative state.
- Engagement ranking or public discovery.

### Reject

- Requiring every post to declare task/decision type, assignee, due date, tags and status before publishing.
- Treating engagement, reactions, or unread volume as priority.
- Unlimited visible reply indentation. Preserve logical ancestry, but use parent excerpts and branch focus instead of an endlessly narrowing tree.
- Agent messages that are visually indistinguishable from humans or system events.
- “AI summary” that silently replaces the record, omits dissent, or cannot show sources.
- Workspace-wide agent/search access inferred from a single installation approval.
- A saved-items bucket with no type, note, owner or lifecycle.
- Claims that the interface alone solves culture, management load, or information hygiene.

## Confidence summary

- **High confidence:** chronology loses obligations; DMs centralize load; titles/outcomes improve rediscovery; users compensate through external tasks/docs; notifications need responsibility-aware filtering; mobile context matters; switching depends on stability and network effects.
- **Medium confidence:** public agent interaction accelerates organizational learning; multiple bounded threads under one post are preferable to one thread per message; a single integrated outcome object can outperform Slack-plus-task-tool for lightweight work.
- **Low confidence / requires product validation:** teams will switch primarily for agent-native participation; one platform can serve friend groups and enterprises equally well; users will accept more structure if AI fills it in; proactive agents can be made helpful without creating new noise.

## Research questions for usability testing

1. Can a new user distinguish a post, a thread under it, and an inline reply without instruction?
2. Does showing a title plus two-line body and outcome chips remove the need to open irrelevant threads?
3. At what point does “create a post” feel too formal compared with sending a channel message?
4. Can a user extract a task/decision and later recover the rationale faster than in Slack plus Linear/Asana?
5. Does “needs me” remain finite and trusted after a week of realistic activity?
6. Do users understand what an agent can read and do before invoking it?
7. Can a mobile user follow a notification to the exact reply, inspect its parent, and return without losing position?
8. Will a group accept a new tool if import preserves content but not every incumbent feature?
