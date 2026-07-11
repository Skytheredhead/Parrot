# Initial feature decisions

Status: provisional until product-model selection, 2026-07-11

| Feature | Decision | Reason |
|---|---|---|
| Space feed of substantive posts | Include | It is the core departure from stream-first chat. |
| Several named threads under one post | Include | It bounds parallel human/agent work without fragmenting the parent context. |
| Full logical reply ancestry with shallow rendering | Include | It respects targeted branching while preserving mobile readability. |
| Title plus visible body preview | Include | User research shows title-only “headlines” hide the actual request. |
| Post types | Include progressively | Discussion is the default; specialized fields appear only when a user chooses a type or extracts an outcome. |
| Decision extraction with rationale and dissent | Include | Recovering the choice and its evidence is a top pain point. |
| Task extraction with owner and source link | Include | Requests currently disappear or are copied into a disconnected tool. |
| Needs-me inbox separate from unread | Include | Responsibility and interruption are not the same as activity. |
| Activity-based resurfacing | Include | It is explicit in Theo's source and solves active old work disappearing. |
| Engagement ranking | Reject | It creates social-feed incentives unrelated to work importance. |
| Direct messages | Include, secondary | Private immediate communication is necessary, but institutional work should be promotable by consent. |
| Arbitrary nested visual replies | Reject | Deep indentation loses context and usable width, especially on mobile. |
| Agent identity, scopes, run ledger, cancel/retry | Include | These are the minimum safe native-agent contract. |
| Consequential-action approval | Include | Autonomy without server-enforced policy is an unacceptable trust boundary. |
| Proactive workspace-wide agent listening | Defer | Noise, privacy, cost, and prompt-injection risks exceed first-release value. |
| Agent-to-agent hierarchies | Defer | The release should first make one agent run inspectable and reliable. |
| Permission-safe object search | Include | Rediscovery is part of the primary value, not an add-on. |
| Large files in SpacetimeDB | Reject | Memory cost, operational risk, preview processing, and signed access favor object storage. |
| Object storage with signed URLs and scanning hook | Include | Protected files are in the success criteria. |
| Full Slack import | Defer | High fidelity and permission mapping would delay proof of the core loop. |
| One-to-one and small-group calling | Reject for first release | It does not prove post-first or agent-native collaboration. |
| Native iOS/Android | Defer | A high-quality responsive PWA is sufficient to validate mobile behavior first. |
| Public social discovery | Reject | It adds engagement, moderation, and abuse dynamics outside the team-work thesis. |
| Federation/open protocol | Defer, preserve extension points | Theo asks for a standard, but protocol semantics remain undefined and should not destabilize the first release. |
| Polls | Include | A poll can produce an explicit, durable outcome with little ceremony. |
| Voice/video/screen sharing | Defer | Useful eventually, but expensive and orthogonal to the core information model. |
| Full project-management portfolio features | Reject | They add bureaucracy and duplicate established tools. |
