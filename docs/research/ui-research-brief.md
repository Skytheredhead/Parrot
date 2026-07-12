# UI research brief — familiar community shell, post-first center

Status: selected prototype direction, 2026-07-12

## Executive read

The evidence does not support inventing an unfamiliar collaboration shell merely to prove the product is different. Discord demonstrates that dense workspace identity, grouped navigation, avatars, presence, reactions, and a persistent member rail can make large communities feel socially legible. The problem is the center: a chronological channel stream still buries substantial work, decisions, and active old discussions. The selected direction therefore keeps a familiar dark community frame while replacing the main channel timeline with a feed of durable posts. Each post can hold several named bounded threads, outcomes, files, and quiet agent receipts. `Needs you` remains finite and explainable rather than becoming a duplicate unread count.

## Evidence → interface mapping

| Evidence or constraint | Confidence | Interface response |
|---|---|---|
| Theo explicitly describes posts as the better primitive and threads as a sub-primitive on a post. | High, primary source | A space opens to substantial posts; one post visibly contains several named thread previews. |
| Active old work should resurface, but users also report notification pressure. | High behavior, qualitative frequency | Feed sort defaults to meaningful recent activity; resurfacing does not generate an interruptive alert by itself. |
| Discord's spatial shell, identity, presence, and social density are familiar to communities. | High capability, not outcome proof | Retain a workspace rail, grouped space index, avatars/presence, compact reactions, and a contextual people rail without copying branding or exact trade dress. |
| Discord Forums, Twist, Zulip, and Teams already provide titled structured conversation. | High | Do not claim posts alone are novel; differentiate with several bounded threads beneath one parent plus outcomes and agent run state. |
| Users improvise headlines, task copies, reminders, and decision docs to escape chronology. | High qualitative | Show a useful title and body preview, decision/task rows with source links, and save/follow behavior on the post itself. |
| Unread activity, responsibility, and urgency are different concepts. | High qualitative | Right rail separates people, accountable agents, and a finite `Needs you` queue whose items explain what clears them. |
| Deep reply indentation loses context and mobile width. | High qualitative for mobile friction | Preserve logical ancestry but render one contextual level with a parent excerpt and branch focus. |
| Agents as teammates, mentions, and tool use are already table stakes. | High capability | Render agents as labeled identities with compact receipts; the review surface shows scope, tools, proposed change, cost/duration, and explicit approval. |

## Selected information architecture

```text
Workspace rail
└── Workspace
    ├── Home / Activity / Calendar
    ├── Spaces
    │   └── Space post feed
    │       └── Post
    │           ├── Named threads
    │           ├── Decision / task
    │           ├── File
    │           └── Agent run
    ├── Resources
    └── Systems
```

The right rail is contextual rather than authoritative. It surfaces present people, installed/accountable agents, and obligations; it does not replace the canonical post/thread record.

## Hero workflow to validate

1. A returning producer opens `Game day` and recognizes the active `Final rundown — Panthers vs. Tigers` post without scanning every reply.
2. They inspect one of three bounded workstreams: `Opening tease`, `Lower thirds`, or `Rain contingency`.
3. They recover the durable decision `Move aerial open to 7:42` with its source and timestamp.
4. They open the Rundown Assistant receipt, inspect the prepared change and authorized context, then approve it.
5. They create a new substantial post without completing a project-management form.

## Guardrails

- Do not let the grouped space index turn the center into a renamed channel stream.
- Do not rank posts by reactions or reply volume.
- Do not make every post type, tag, owner, due date, or status mandatory.
- Do not place agents only in a separate AI surface or make their output visually indistinguishable from human work.
- Do not use Discord branding, proprietary assets, exact icons, server art, or exact layouts.
- Do not squeeze the desktop shell onto mobile; mobile becomes a full-width post feed with sticky context and bottom navigation.

## Open validation questions

- Can a Discord-heavy user immediately distinguish a space, post, named thread, and contextual reply?
- Does the familiar shell reduce adoption friction without causing users to expect channel-first chat behavior?
- Are several named threads genuinely more useful than one thread per post, or do they add avoidable hierarchy?
- Does `Needs you` remain trusted after a week of realistic activity?
- Can users predict what the agent can read and do before approval?
- On mobile, can a notification restore the exact reply context and return position?
