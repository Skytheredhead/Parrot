import {
  Bell,
  Broadcast,
  CalendarBlank,
  CaretDown,
  CaretUp,
  ChatCircleDots,
  Check,
  CheckCircle,
  DotsThree,
  Eyes,
  FilePdf,
  FileText,
  Fire,
  FolderSimple,
  Hash,
  House,
  Lightning,
  MagnifyingGlass,
  MicrophoneStage,
  Mountains,
  Paperclip,
  PencilSimple,
  Plus,
  Robot,
  ShieldCheck,
  SlidersHorizontal,
  Smiley,
  Star,
  ThumbsUp,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProductionApp } from "./useProductionApp.js";

const people = [
  { name: "Jordan Lee", role: "Producer", image: "/avatars/jordan.png", status: "online" },
  { name: "Taylor Morgan", role: "Director", image: "/avatars/taylor.png", status: "online" },
  { name: "Casey Nguyen", role: "Graphics Lead", image: "/avatars/casey.png", status: "online" },
  { name: "Sam Cole", role: "Play-by-Play", image: "/avatars/sam.png", status: "online" },
  { name: "Alex Rivers", role: "Analyst", image: "/avatars/alex.png", status: "away" },
];

const threads = [
  {
    id: "opening",
    title: "Opening tease",
    preview: "Sam Cole: Pushed a new VO option for the open.",
    count: 4,
    time: "9:41 AM",
    tone: "violet",
  },
  {
    id: "lower-thirds",
    title: "Lower thirds",
    preview: "Casey Nguyen: Locked styles. Need one more sponsor logo.",
    count: 3,
    time: "10:06 AM",
    tone: "green",
  },
  {
    id: "rain",
    title: "Rain contingency",
    preview: "Taylor Morgan: If rain hits in Q4, we’ll move to Plan B graphics.",
    count: 5,
    time: "10:22 AM",
    tone: "amber",
  },
];

const initialPosts = [
  {
    id: "rundown",
    demo: true,
    author: "Jordan Lee",
    role: "Producer",
    image: "/avatars/jordan.png",
    title: "Final rundown — Panthers vs. Tigers",
    body: "Here’s the final rundown for today’s 3:30 PM ET kickoff. Weather looks steady through halftime with a slight chance of showers in the 4th quarter.",
    created: "9:18 AM",
    edited: "Edited 9:32 AM",
    audience: "Game day crew (28)",
    details: [
      ["Broadcast window", "3:00–7:00 PM ET"],
      ["Location", "Riverside Field"],
      ["Talent", "Alex Rivers, Sam Cole, Casey Nguyen"],
      ["Key story", "Panthers defense vs. Tigers passing game"],
      ["Reminders", "Clear mics pre-show • Hydrate • Check comms on channel 1"],
    ],
  },
  {
    id: "blocking",
    demo: true,
    author: "Taylor Morgan",
    role: "Director",
    image: "/avatars/taylor.png",
    title: "Camera blocking notes",
    body: "Updated camera blocking for both team intros and the coin toss. The revised markup keeps Camera 3 clear of the midfield cable run.",
    created: "11:02 AM",
    edited: "",
    audience: "Directors (6)",
    details: [],
  },
];

function Avatar({ src, name, size = "md", status }) {
  return (
    <span className={`avatar avatar-${size}`}>
      <img src={src} alt={`${name} profile`} />
      {status ? <span className={`presence presence-${status}`} title={status} /> : null}
    </span>
  );
}

function IconButton({ label, children, active = false, onClick, className = "" }) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function WorkspaceRail({ onToast }) {
  return (
    <aside className="workspace-rail" aria-label="Workspaces">
      <IconButton
        label="Saturday Broadcast"
        active
        onClick={() => onToast("Saturday Broadcast selected")}
      >
        <Broadcast weight="fill" />
      </IconButton>
      <div className="rail-divider" />
      <IconButton label="Search workspaces" onClick={() => onToast("Workspace search opened")}>
        <MagnifyingGlass />
      </IconButton>
      <IconButton
        label="Add workspace"
        className="rail-add"
        onClick={() => onToast("Create workspace is outside this prototype")}
      >
        <Plus />
      </IconButton>
      <IconButton
        label="Media production"
        onClick={() => onToast("Media Production workspace selected")}
      >
        <MicrophoneStage weight="fill" />
      </IconButton>
      <IconButton label="Creative team" onClick={() => onToast("Creative Team workspace selected")}>
        <Star weight="fill" />
      </IconButton>
      <IconButton label="Security" onClick={() => onToast("Security workspace selected")}>
        <ShieldCheck weight="fill" />
      </IconButton>
      <IconButton label="Field crew" onClick={() => onToast("Field Crew workspace selected")}>
        <Mountains weight="fill" />
      </IconButton>
      <IconButton
        label="Create workspace"
        className="rail-outline"
        onClick={() => onToast("Create workspace is outside this prototype")}
      >
        <Plus />
      </IconButton>
    </aside>
  );
}

function NavItem({ icon: Icon, children, active, count, onClick }) {
  return (
    <button type="button" className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <Icon weight={active ? "fill" : "regular"} />
      <span>{children}</span>
      {count ? <span className="nav-count">{count}</span> : null}
    </button>
  );
}

function SectionLabel({ children, action, onAction }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {action ? (
        <button type="button" aria-label={action} onClick={onAction}>
          <Plus />
        </button>
      ) : null}
    </div>
  );
}

function Navigation({
  selectedSpace,
  setSelectedSpace,
  onToast,
  workspaceName,
  liveSpaces,
  notificationCount = 3,
}) {
  const spaces = liveSpaces ?? [
    "Announcements",
    "Production hub",
    "Game day",
    "Graphics",
    "Replays & clips",
    "Talent lounge",
    "Vendors",
  ];
  const resources = [
    ["Rundowns", FileText],
    ["Creative brief", FileText],
    ["Brand kit", FileText],
    ["Shared drives", FolderSimple],
  ];
  return (
    <aside className="navigation">
      <div className="workspace-title">
        <span>{workspaceName ?? "Saturday Broadcast"}</span>
        <CaretDown />
        <IconButton label="Edit workspace" onClick={() => onToast("Workspace settings opened")}>
          <PencilSimple />
        </IconButton>
      </div>
      <nav aria-label="Workspace navigation">
        <NavItem icon={House} onClick={() => onToast("Home selected")}>
          Home
        </NavItem>
        <NavItem
          icon={Bell}
          count={notificationCount || undefined}
          onClick={() => onToast("Activity opened")}
        >
          Activity
        </NavItem>
        <NavItem icon={CalendarBlank} onClick={() => onToast("Calendar opened")}>
          Calendar
        </NavItem>
        <SectionLabel action="Add space" onAction={() => onToast("New space composer opened")}>
          Spaces
        </SectionLabel>
        {spaces.map((space) => {
          const id = typeof space === "string" ? space : space.id;
          const label = typeof space === "string" ? space : space.name;
          return (
            <NavItem
              key={id}
              icon={Hash}
              active={selectedSpace === id}
              onClick={() => setSelectedSpace(id, label)}
            >
              {label}
            </NavItem>
          );
        })}
        <SectionLabel>Resources</SectionLabel>
        {resources.map(([label, Icon]) => (
          <NavItem key={label} icon={Icon} onClick={() => onToast(`${label} opened`)}>
            {label}
          </NavItem>
        ))}
        <SectionLabel>Systems</SectionLabel>
        <NavItem icon={Lightning} onClick={() => onToast("Automation opened")}>
          Automation
        </NavItem>
        <NavItem icon={Robot} onClick={() => onToast("Integrations opened")}>
          Integrations
        </NavItem>
        <NavItem icon={FileText} onClick={() => onToast("Logs opened")}>
          Logs
        </NavItem>
      </nav>
      <button type="button" className="profile-row" onClick={() => onToast("Profile menu opened")}>
        <Avatar src="/avatars/maya.png" name="Maya Patel" status="online" />
        <span>
          <strong>Maya Patel</strong>
          <small>Online</small>
        </span>
        <CaretDown />
      </button>
    </aside>
  );
}

function Header({ query, setQuery, onCreate, onToast, spaceName }) {
  return (
    <header className="topbar">
      <div className="channel-heading">
        <div>
          <strong>{spaceName ?? "Game day"}</strong>
          <CaretDown />
        </div>
        <span>Live production for games and events.</span>
      </div>
      <div className="topbar-actions">
        <IconButton label="Feed filters" onClick={() => onToast("Feed filters opened")}>
          <SlidersHorizontal />
        </IconButton>
        <label className="search-box">
          <MagnifyingGlass />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search posts"
            aria-label="Search posts"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
              <X />
            </button>
          ) : null}
        </label>
        <button type="button" className="primary-button" onClick={onCreate}>
          <PencilSimple weight="bold" /> Create a post
        </button>
        <IconButton label="Notifications" onClick={() => onToast("Notifications opened")}>
          <Bell />
        </IconButton>
      </div>
    </header>
  );
}

function SearchResults({ query, state, onMore }) {
  if (!query.trim()) return null;
  return (
    <section className="search-results" aria-label="Search results" aria-live="polite">
      <div>
        <strong>Authorized results</strong>
        <span>{state.status === "loading" ? "Searching…" : `${state.items.length} found`}</span>
      </div>
      {state.error ? <p className="search-error">{state.error}</p> : null}
      {state.items.map((item) => (
        <article key={`${item.kind}-${item.id}`}>
          <span>{item.kind.replaceAll("_", " ")}</span>
          <div className="search-result-copy">
            <strong>{item.title}</strong>
            <p>{item.snippet}</p>
          </div>
          <time className="search-result-date">
            {new Date(item.occurredAt).toLocaleDateString()}
          </time>
        </article>
      ))}
      {state.status === "ready" && state.items.length === 0 ? (
        <p className="search-result-empty">No authorized results found.</p>
      ) : null}
      {state.nextCursor ? (
        <button type="button" className="quiet-link" onClick={onMore}>
          Load more
        </button>
      ) : null}
    </section>
  );
}

function Reaction({ icon: Icon, label, initialCount, onToast }) {
  const [selected, setSelected] = useState(false);
  return (
    <button
      type="button"
      className={`reaction ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${label}: ${initialCount + (selected ? 1 : 0)}`}
      onClick={() => {
        setSelected((value) => !value);
        onToast(selected ? `${label} reaction removed` : `${label} reaction added`);
      }}
    >
      <Icon weight={selected ? "fill" : "regular"} />
      <span>{initialCount + (selected ? 1 : 0)}</span>
    </button>
  );
}

function MediaStrip() {
  return (
    <div className="media-strip">
      <button type="button" className="file-tile">
        <span>
          <FilePdf weight="fill" />
        </span>
        <span>
          <strong>Rundown_v7.pdf</strong>
          <small>PDF • 248 KB</small>
        </span>
      </button>
      <figure>
        <img src="/media/field-cam.png" alt="Football field camera view" />
        <figcaption>Field cam</figcaption>
      </figure>
      <figure>
        <img src="/media/booth-setup.png" alt="Sports broadcast control booth" />
        <figcaption>Booth setup</figcaption>
      </figure>
      <figure>
        <img src="/media/weather-graphic.png" alt="Storm radar weather graphic" />
        <figcaption>Weather graphic</figcaption>
      </figure>
    </div>
  );
}

function ThreadRow({ thread, expanded, onOpen, onReply }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const contributions = thread.contributions;
  const submitReply = async () => {
    if (!reply.trim() || !onReply) return;
    setSending(true);
    try {
      await onReply(thread.id, reply.trim());
      setReply("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`thread-wrap ${expanded ? "expanded" : ""}`}>
      <button
        type="button"
        className="thread-row"
        onClick={() => onOpen(thread.id)}
        aria-expanded={expanded}
      >
        <span className={`thread-icon ${thread.tone}`}>
          <ChatCircleDots weight="fill" />
        </span>
        <span className="thread-copy">
          <strong>{thread.title}</strong>
          <small>{thread.preview}</small>
        </span>
        <span className="thread-avatars">
          <Avatar src="/avatars/jordan.png" name="Jordan Lee" size="xs" />
          <Avatar src="/avatars/taylor.png" name="Taylor Morgan" size="xs" />
          <span className="thread-count">{thread.count}</span>
        </span>
        <time>{thread.time}</time>
        {expanded ? <CaretUp /> : <CaretDown />}
      </button>
      {expanded ? (
        <div className="thread-preview-panel">
          {contributions ? (
            contributions.length ? (
              contributions.map((message) => (
                <div className="mini-message" key={message.id}>
                  <Avatar src="/avatars/jordan.png" name={message.author} size="sm" />
                  <p>
                    <strong>{message.author}</strong>
                    <span>{message.body}</span>
                    <small>{message.created}</small>
                  </p>
                </div>
              ))
            ) : (
              <p className="thread-empty">No replies yet. Start the conversation.</p>
            )
          ) : (
            <>
              <div className="mini-message">
                <Avatar src="/avatars/sam.png" name="Sam Cole" size="sm" />
                <p>
                  <strong>Sam Cole</strong>
                  <span>I’ve attached the latest pass. The timing lands at 18 seconds.</span>
                </p>
              </div>
              <div className="mini-message">
                <Avatar src="/avatars/casey.png" name="Casey Nguyen" size="sm" />
                <p>
                  <strong>Casey Nguyen</strong>
                  <span>Looks good from graphics. I’ll keep the sponsor lockup clear.</span>
                </p>
              </div>
            </>
          )}
          <label className="quick-reply">
            <input
              aria-label={`Reply in ${thread.title}`}
              placeholder={`Reply in ${thread.title}`}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitReply();
              }}
            />
            <button
              type="button"
              disabled={sending || !reply.trim()}
              onClick={() => void submitReply()}
            >
              {sending ? "Sending…" : "Reply"}
            </button>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function OutcomeRows({ onReview, onToast, agentApproved }) {
  return (
    <div className="outcome-list">
      <button
        type="button"
        className="outcome decision"
        onClick={() => onToast("Decision details opened")}
      >
        <span>
          <CheckCircle weight="fill" />
        </span>
        <p>
          <strong>Decision</strong> Move aerial open to 7:42
          <small>Decided by Jordan Lee • Jul 12, 2026 • 10:48 AM</small>
        </p>
        <em>View details</em>
      </button>
      <button
        type="button"
        className={`outcome agent ${agentApproved ? "approved" : ""}`}
        onClick={onReview}
      >
        <span>
          <Robot weight="fill" />
        </span>
        <p>
          <strong>{agentApproved ? "Approved" : "Agent"}</strong> Rundown assistant checked 12
          source files — {agentApproved ? "cue sheet update approved" : "approval needed"}
          <small>Rundown Assistant • Jul 12, 2026 • 10:51 AM</small>
        </p>
        <em>{agentApproved ? "View receipt" : "Open review"}</em>
      </button>
    </div>
  );
}

function PostCard({
  post,
  expandedThread,
  setExpandedThread,
  onReview,
  onToast,
  agentApproved,
  onCreateThread,
  onReply,
}) {
  const isPrimary = post.id === "rundown";
  const postThreads = post.threads ?? (isPrimary ? threads : []);
  const [threadTitle, setThreadTitle] = useState("");
  const [threading, setThreading] = useState(false);
  return (
    <article className={`post-card ${isPrimary ? "primary-post" : "secondary-post"}`}>
      <header className="post-author">
        <Avatar src={post.image} name={post.author} status="online" />
        <div>
          <strong>{post.author}</strong>
          <span className={`role role-${post.role.toLowerCase()}`}>{post.role}</span>
          <small>
            Jul 12, 2026 • {post.created} {post.edited ? `• ${post.edited}` : ""}
          </small>
        </div>
        <p>
          Audience:{" "}
          <button type="button" onClick={() => onToast("Audience details opened")}>
            {post.audience}
          </button>
        </p>
        <IconButton label="Post actions" onClick={() => onToast("Post actions opened")}>
          <DotsThree weight="bold" />
        </IconButton>
      </header>
      <div className="post-body">
        <h2>{post.title}</h2>
        <p>{post.body}</p>
        {post.details.length ? (
          <ul className="detail-list">
            {post.details.map(([label, value]) => (
              <li key={label}>
                <strong>{label}:</strong> {value}
              </li>
            ))}
          </ul>
        ) : null}
        {post.demo && isPrimary ? (
          <MediaStrip />
        ) : post.demo ? (
          <div className="document-preview">
            <FileText />
            <span>Camera_blocking_notes.pdf</span>
          </div>
        ) : null}
      </div>
      <div className="reaction-row">
        <Reaction icon={ThumbsUp} label="Helpful" initialCount={12} onToast={onToast} />
        <Reaction icon={Fire} label="Fire" initialCount={7} onToast={onToast} />
        <Reaction icon={Eyes} label="Watching" initialCount={5} onToast={onToast} />
        <IconButton
          label="Add reaction"
          className="add-reaction"
          onClick={() => onToast("Reaction picker opened")}
        >
          <Smiley />
        </IconButton>
      </div>
      {postThreads.length || onCreateThread ? (
        <>
          <div className="thread-heading">
            <button
              type="button"
              onClick={() =>
                postThreads[0] && setExpandedThread(expandedThread ? null : postThreads[0].id)
              }
            >
              {postThreads.length} {postThreads.length === 1 ? "thread" : "threads"}{" "}
              {expandedThread ? <CaretUp /> : <CaretDown />}
            </button>
          </div>
          <div className="thread-list">
            {postThreads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                expanded={expandedThread === thread.id}
                onOpen={(id) => setExpandedThread(expandedThread === id ? null : id)}
                onReply={onReply}
              />
            ))}
          </div>
          {onCreateThread ? (
            <form
              className="new-thread"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!threadTitle.trim()) return;
                setThreading(true);
                try {
                  await onCreateThread(post.id, threadTitle.trim());
                  setThreadTitle("");
                } finally {
                  setThreading(false);
                }
              }}
            >
              <input
                aria-label={`New thread on ${post.title}`}
                placeholder="Start a named thread"
                value={threadTitle}
                onChange={(event) => setThreadTitle(event.target.value)}
              />
              <button type="submit" disabled={threading || !threadTitle.trim()}>
                {threading ? "Starting…" : "Start thread"}
              </button>
            </form>
          ) : null}
          {post.demo ? (
            <OutcomeRows onReview={onReview} onToast={onToast} agentApproved={agentApproved} />
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function RightRail({ onReview, onToast, completed, setCompleted, files, onDownload, fileState }) {
  const agents = [
    ["Rundown Assistant", "Watching for updates", true],
    ["Graphic Preflight", "Monitoring assets", true],
    ["Clip Logger", "Idle", false],
  ];
  const needs = [
    ["Approve sponsor slate", "In Graphics", "Due today, 1:00 PM", "violet"],
    ["Confirm talent mics", "In Production hub", "Due today, 12:00 PM", "amber"],
    ["Review Plan B graphics", "In Game day", "Due today, 2:00 PM", "green"],
  ];
  return (
    <aside className="context-rail">
      <section>
        <h3>People online — 16</h3>
        <div className="person-list">
          {people.map((person) => (
            <button
              type="button"
              key={person.name}
              onClick={() => onToast(`${person.name} profile opened`)}
            >
              <Avatar src={person.image} name={person.name} status={person.status} />
              <span>
                <strong>{person.name}</strong>
                <small>{person.role}</small>
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="quiet-link"
          onClick={() => onToast("Member directory opened")}
        >
          See all
        </button>
      </section>
      {files ? (
        <section>
          <h3>Files — {files.length}</h3>
          <div className="live-file-list">
            {files.slice(0, 6).map((file) => (
              <button
                type="button"
                key={file.id}
                disabled={file.state !== "Clean" || fileState?.status === "downloading"}
                onClick={() => onDownload(file.id)}
              >
                <FileText />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.state === "Clean" ? "Clean · Download" : file.state}</small>
                </span>
              </button>
            ))}
            {files.length === 0 ? <p className="rail-empty">No files in this space.</p> : null}
          </div>
          {fileState?.status !== "idle" ? (
            <p className={`file-operation ${fileState.status}`} role="status">
              {fileState.error ||
                (fileState.status === "uploading"
                  ? `Uploading ${fileState.name}…`
                  : fileState.status === "quarantined"
                    ? `${fileState.name} is quarantined for scanning.`
                    : "Preparing download…")}
            </p>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3>Accountable agents — 3</h3>
        <div className="agent-list">
          {agents.map(([name, status, online]) => (
            <button
              type="button"
              key={name}
              onClick={
                name === "Rundown Assistant" ? onReview : () => onToast(`${name} profile opened`)
              }
            >
              <span className="agent-avatar">
                <Robot weight="fill" />
                <i className={online ? "online" : "offline"} />
              </span>
              <span>
                <strong>{name}</strong>
                <small>{status}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h3>Needs you — {needs.length - completed.length}</h3>
        <div className="needs-list">
          {needs.map(([title, location, due, tone], index) => {
            const done = completed.includes(index);
            return (
              <button
                type="button"
                key={title}
                className={done ? "done" : ""}
                onClick={() =>
                  setCompleted((items) =>
                    done ? items.filter((item) => item !== index) : [...items, index],
                  )
                }
              >
                <span className={`need-icon ${tone}`}>
                  {done ? (
                    <Check />
                  ) : index === 0 ? (
                    <FileText />
                  ) : index === 1 ? (
                    <MicrophoneStage />
                  ) : (
                    <FolderSimple />
                  )}
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{done ? "Completed" : location}</small>
                  <em>{done ? "Click to restore" : due}</em>
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="quiet-link"
          onClick={() => onToast("Needs you inbox opened")}
        >
          See all tasks
        </button>
      </section>
    </aside>
  );
}

function Composer({ onClose, onPublish, live }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);
  const canPublish = title.trim().length > 3 && body.trim().length > 5;
  const titleRef = useRef(null);
  useEffect(() => titleRef.current?.focus(), []);
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <header>
          <div>
            <span>Game day</span>
            <h2 id="composer-title">Create a post</h2>
          </div>
          <IconButton label="Close composer" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <label>
          Title
          <input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What should people know?"
          />
        </label>
        <label>
          Post body
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add the context people will need when they return later…"
            rows="6"
          />
        </label>
        <div className="composer-tools">
          <input
            ref={fileRef}
            className="visually-hidden"
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <button type="button" onClick={() => fileRef.current?.click()}>
            <Paperclip /> Attach file
          </button>
          <button type="button">
            <UsersThree /> Game day crew
          </button>
        </div>
        {file ? (
          <p className="selected-file">
            <Paperclip /> {file.name} · {Math.ceil(file.size / 1024)} KB
          </p>
        ) : null}
        <footer>
          <p>Threads, decisions, and tasks can be added after publishing.</p>
          <button
            type="button"
            className="primary-button"
            disabled={!canPublish}
            onClick={() => onPublish({ title, body, file: live ? file : null })}
          >
            Publish post
          </button>
        </footer>
      </section>
    </div>
  );
}

function AgentReview({ approved, onApprove, onClose }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-title"
      >
        <header>
          <div className="agent-title">
            <span className="agent-avatar large">
              <Robot weight="fill" />
            </span>
            <div>
              <span>Rundown Assistant</span>
              <h2 id="agent-title">Cue sheet update</h2>
            </div>
          </div>
          <IconButton label="Close review" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div className="approval-summary">
          <ShieldCheck weight="fill" />
          <p>
            <strong>{approved ? "Approved" : "Approval required"}</strong>
            <span>
              The assistant prepared one update but cannot change the shared cue sheet without you.
            </span>
          </p>
        </div>
        <dl className="run-details">
          <div>
            <dt>Context</dt>
            <dd>Final rundown post + 12 attached source files</dd>
          </div>
          <div>
            <dt>Action</dt>
            <dd>Move the aerial open cue to 7:42</dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>Read files, compare versions, prepare cue-sheet patch</dd>
          </div>
          <div>
            <dt>Cost / duration</dt>
            <dd>$0.04 • 42 seconds</dd>
          </div>
        </dl>
        <div className="change-preview">
          <span>Prepared change</span>
          <p>
            <del>Opening aerial — 7:38</del>
            <ins>Opening aerial — 7:42</ins>
          </p>
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
          {approved ? (
            <button type="button" className="primary-button" onClick={onClose}>
              <Check /> Approved
            </button>
          ) : (
            <button type="button" className="primary-button" onClick={onApprove}>
              Approve update
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function ProductionGate({ title, message, action, actionLabel }) {
  return (
    <main className="production-gate">
      <div className="production-gate-card">
        <span className="parrot-mark">
          <Broadcast weight="fill" />
        </span>
        <p className="eyebrow">Parrot</p>
        <h1>{title}</h1>
        <p>{message}</p>
        {action ? (
          <button type="button" className="primary-button" onClick={action}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </main>
  );
}

export function App({ auth }) {
  const production = useProductionApp(auth);
  const [selectedSpace, setSelectedSpace] = useState("Game day");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("Recent activity");
  const [expandedThread, setExpandedThread] = useState(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [agentApproved, setAgentApproved] = useState(false);
  const [completed, setCompleted] = useState([]);
  const [posts, setPosts] = useState(initialPosts);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const showToast = (message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2400);
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const liveWorkspace = production.data.workspaces.find(
    (workspace) => workspace.id === production.selectedWorkspaceId,
  );
  const liveSpaces = production.data.spaces.filter(
    (space) => space.workspaceId === production.selectedWorkspaceId,
  );
  const liveSpace = liveSpaces.find((space) => space.id === production.selectedSpaceId);
  const displayedPosts = production.live
    ? production.data.posts.filter(
        (post) => !production.selectedSpaceId || post.spaceId === production.selectedSpaceId,
      )
    : posts;
  useEffect(() => {
    if (!production.live) return undefined;
    const timer = window.setTimeout(() => void production.search(query), query.trim() ? 280 : 0);
    return () => window.clearTimeout(timer);
  }, [production.live, production.search, query]);
  const filteredPosts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (production.live && normalized) {
      const allowedPostIds = new Set(
        production.searchState.items.filter((item) => item.kind === "post").map((item) => item.id),
      );
      return displayedPosts.filter((post) => allowedPostIds.has(post.id));
    }
    return normalized
      ? displayedPosts.filter((post) =>
          `${post.title} ${post.body} ${post.author}`.toLowerCase().includes(normalized),
        )
      : displayedPosts;
  }, [displayedPosts, production.live, production.searchState.items, query]);
  const publishPost = async ({ title, body, file }) => {
    if (production.live) {
      try {
        await production.createPost({ title, body });
        if (file) await production.uploadFile(file);
        setComposerOpen(false);
        showToast(file ? "Post published; attachment queued for scanning" : "Post published");
      } catch (reason) {
        showToast(reason instanceof Error ? reason.message : "Post could not be published");
      }
      return;
    }
    setPosts((items) => [
      {
        id: `post-${Date.now()}`,
        author: "Maya Patel",
        role: "Coordinator",
        image: "/avatars/maya.png",
        title,
        body,
        created: "Now",
        edited: "",
        audience: "Game day crew (28)",
        details: [],
      },
      ...items,
    ]);
    setComposerOpen(false);
    showToast("Post published to Game day");
  };
  if (production.live && !production.configured) {
    return (
      <ProductionGate title="Parrot needs its production settings" message={production.error} />
    );
  }
  if (
    production.live &&
    (production.status === "signed-out" || production.status === "authenticating")
  ) {
    return (
      <ProductionGate
        title={
          production.status === "authenticating"
            ? "Restoring your session…"
            : "Your team, back in context"
        }
        message={production.error || "Sign in with WorkOS to open your Parrot workspace."}
        action={production.status === "signed-out" ? production.signIn : undefined}
        actionLabel="Sign in"
      />
    );
  }
  if (production.live && production.status === "bootstrap-required") {
    return (
      <ProductionGate
        title="Create your first Parrot workspace"
        message="This account does not have a workspace yet. Parrot will create one owner workspace, then switch to short-lived gateway database tickets."
        action={() => void production.bootstrapWorkspace()}
        actionLabel="Create Parrot workspace"
      />
    );
  }
  if (
    production.live &&
    ["connecting", "discovering", "bootstrapping"].includes(production.status) &&
    production.data.workspaces.length === 0
  ) {
    return (
      <ProductionGate
        title={
          production.status === "bootstrapping"
            ? "Creating your workspace…"
            : "Connecting to your workspace…"
        }
        message="Parrot is establishing an encrypted realtime session."
      />
    );
  }
  return (
    <div className="app-shell">
      {production.live && (production.status === "reconnecting" || production.error) ? (
        <div className="connection-banner" role="status">
          <span>
            {production.status === "reconnecting"
              ? "Connection interrupted — reconnecting…"
              : production.error}
          </span>
          <button type="button" onClick={production.signOut}>
            Sign out
          </button>
        </div>
      ) : null}
      <WorkspaceRail onToast={showToast} />
      <Navigation
        selectedSpace={production.live ? production.selectedSpaceId : selectedSpace}
        setSelectedSpace={(space, label = space) => {
          if (production.live) production.setSelectedSpaceId(space);
          else setSelectedSpace(space);
          showToast(`${label} selected`);
        }}
        workspaceName={liveWorkspace?.name}
        liveSpaces={production.live ? liveSpaces : undefined}
        notificationCount={
          production.live ? production.data.notifications.filter((item) => item.unread).length : 3
        }
        onToast={showToast}
      />
      <main className="main-column">
        <Header
          query={query}
          setQuery={setQuery}
          onCreate={() => setComposerOpen(true)}
          onToast={showToast}
          spaceName={liveSpace?.name}
        />
        <div className="feed-scroll">
          <div className="feed-toolbar">
            <button
              type="button"
              onClick={() =>
                setSort((value) =>
                  value === "Recent activity" ? "Newest post" : "Recent activity",
                )
              }
            >
              Sort: <strong>{sort}</strong>
              <CaretDown />
            </button>
          </div>
          {production.live ? (
            <SearchResults
              query={query}
              state={production.searchState}
              onMore={() => void production.search(query, { append: true })}
            />
          ) : null}
          <div className="feed">
            {filteredPosts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                expandedThread={expandedThread}
                setExpandedThread={setExpandedThread}
                onReview={() => setReviewOpen(true)}
                onToast={showToast}
                agentApproved={agentApproved}
                onCreateThread={
                  production.live
                    ? async (postId, title) => {
                        try {
                          await production.createThread(postId, title);
                          showToast("Thread started");
                        } catch (reason) {
                          showToast(
                            reason instanceof Error
                              ? reason.message
                              : "Thread could not be started",
                          );
                          throw reason;
                        }
                      }
                    : undefined
                }
                onReply={
                  production.live
                    ? async (threadId, body) => {
                        try {
                          await production.replyToThread(threadId, body);
                          showToast("Reply sent");
                        } catch (reason) {
                          showToast(
                            reason instanceof Error ? reason.message : "Reply could not be sent",
                          );
                          throw reason;
                        }
                      }
                    : undefined
                }
              />
            ))}
            {filteredPosts.length === 0 ? (
              <div className="empty-state">
                <MagnifyingGlass />
                <h2>No posts found</h2>
                <p>Try a different title, author, or phrase.</p>
                <button type="button" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </main>
      <RightRail
        onReview={() => setReviewOpen(true)}
        onToast={showToast}
        completed={completed}
        setCompleted={setCompleted}
        files={
          production.live
            ? production.data.files.filter((file) => file.spaceId === production.selectedSpaceId)
            : undefined
        }
        onDownload={production.downloadFile}
        fileState={production.fileState}
      />
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <IconButton label="Home">
          <House weight="fill" />
        </IconButton>
        <IconButton label="Spaces" active>
          <Hash weight="fill" />
        </IconButton>
        <button
          type="button"
          className="mobile-create"
          aria-label="Create post"
          onClick={() => setComposerOpen(true)}
        >
          <Plus />
        </button>
        <IconButton label="Activity">
          <Bell />
        </IconButton>
        <IconButton label="Profile">
          <UsersThree />
        </IconButton>
      </nav>
      {composerOpen ? (
        <Composer
          onClose={() => setComposerOpen(false)}
          onPublish={publishPost}
          live={production.live}
        />
      ) : null}
      {reviewOpen ? (
        <AgentReview
          approved={agentApproved}
          onClose={() => setReviewOpen(false)}
          onApprove={() => {
            setAgentApproved(true);
            setReviewOpen(false);
            showToast("Cue sheet update approved");
          }}
        />
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          <CheckCircle weight="fill" />
          {toast}
        </div>
      ) : null}
    </div>
  );
}
