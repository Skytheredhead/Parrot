import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addThreadReply,
  bootstrapOwner,
  connectTicketedRealtime,
  connectWorkspaceDiscovery,
  createGatewayClient,
  createNamedThread,
  randomUuid,
  readProductionConfig,
  uploadFileWithCapability,
  uuid,
} from "./production-runtime.js";

const EMPTY_DATA = {
  workspaces: [],
  spaces: [],
  posts: [],
  threads: [],
  notifications: [],
  files: [],
};
const WORKSPACE_ID_KEY = "parrot.workspace_id";

function workspaceStorage() {
  return typeof globalThis.localStorage?.getItem === "function" ? globalThis.localStorage : null;
}

function valueString(value) {
  return value?.toString?.() ?? String(value ?? "");
}

function displayTime(value) {
  try {
    const micros = value?.__timestamp_micros_since_unix_epoch__;
    const date =
      micros === undefined ? new Date(valueString(value)) : new Date(Number(micros / 1000n));
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return "Now";
  }
}

function rows(table) {
  return table ? Array.from(table.iter()) : [];
}

export function snapshotRealtime(connection, profile = {}) {
  const workspaces = rows(connection.db.myWorkspaces).map((row) => ({
    id: valueString(row.id),
    name: row.name,
  }));
  const spaces = rows(connection.db.visibleSpaces)
    .filter((row) => !row.archived)
    .map((row) => ({
      id: valueString(row.id),
      workspaceId: valueString(row.workspaceId),
      name: row.name,
    }));
  const threadRows = rows(connection.db.visibleNamedThreads).filter((row) => !row.archived);
  const contributionRows = rows(connection.db.visibleContributions).filter((row) => !row.deleted);
  const currentIdentity = rows(connection.db.currentGatewayPrincipal)[0]?.identity;
  const currentIdentityString = valueString(currentIdentity);
  const mappedThreads = threadRows.map((thread) => {
    const contributions = contributionRows
      .filter((item) => valueString(item.threadId) === valueString(thread.id))
      .map((item) => ({
        id: valueString(item.id),
        author: valueString(item.authorIdentity) === currentIdentityString ? "You" : "Team member",
        body: item.body,
        created: displayTime(item.createdAt),
      }));
    const latest = contributions.at(-1);
    return {
      id: valueString(thread.id),
      rootPostId: valueString(thread.rootPostId),
      title: thread.title,
      preview: latest ? `${latest.author}: ${latest.body}` : "No replies yet.",
      count: contributions.length,
      time: displayTime(thread.updatedAt),
      tone: "violet",
      contributions,
    };
  });
  const posts = rows(connection.db.visiblePosts)
    .filter((row) => !row.deleted)
    .map((row) => {
      const id = valueString(row.id);
      const mine = valueString(row.authorIdentity) === currentIdentityString;
      return {
        id,
        workspaceId: valueString(row.workspaceId),
        spaceId: valueString(row.spaceId),
        author: mine ? profile.name || profile.email || "You" : "Team member",
        role: mine ? "Member" : "Contributor",
        image: mine ? "/avatars/maya.png" : "/avatars/jordan.png",
        title: row.title,
        body: row.body,
        created: displayTime(row.createdAt),
        edited: row.revision > 1n ? `Edited ${displayTime(row.updatedAt)}` : "",
        audience: "Workspace members",
        details: [],
        threads: mappedThreads.filter((thread) => thread.rootPostId === id),
      };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
  const notifications = rows(connection.db.myNotifications).map((row) => ({
    id: valueString(row.id),
    workspaceId: valueString(row.workspaceId),
    summary: row.summary,
    kind: Object.keys(row.kind ?? {})[0] ?? "System",
    unread: row.readAt === undefined || row.readAt === null,
  }));
  const files = rows(connection.db.visibleFiles).map((row) => ({
    id: valueString(row.id),
    workspaceId: valueString(row.workspaceId),
    spaceId: valueString(row.spaceId),
    name: row.fileName,
    sizeBytes: Number(row.declaredSizeBytes),
    contentType: row.detectedType,
    state: row.state?.tag ?? "Uploaded",
  }));
  return { workspaces, spaces, posts, threads: mappedThreads, notifications, files };
}

function playNotificationTone() {
  const AudioContext = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.setValueAtTime(740, context.currentTime);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.17);
  oscillator.addEventListener("ended", () => context.close());
}

export function useProductionApp(auth) {
  const config = useMemo(() => readProductionConfig(), []);
  const gatewayRef = useRef(null);
  const connectionRef = useRef(null);
  const discoveryRef = useRef(null);
  const retryRef = useRef(0);
  const soundEnabled = useRef(false);
  const searchCursorRef = useRef(undefined);
  const searchRequestRef = useRef(0);
  const profileRef = useRef(auth?.user ?? {});
  const [status, setStatus] = useState(config.live ? "signed-out" : "demo");
  const [error, setError] = useState(
    config.configured === false ? `Missing production settings: ${config.missing.join(", ")}` : "",
  );
  const [data, setData] = useState(EMPTY_DATA);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [workspaceScopeId, setWorkspaceScopeId] = useState(
    () => config.workspaceId || workspaceStorage()?.getItem(WORKSPACE_ID_KEY) || "",
  );
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
  const [searchState, setSearchState] = useState({
    status: "idle",
    items: [],
    nextCursor: undefined,
    error: "",
  });
  const [fileState, setFileState] = useState({ status: "idle", name: "", error: "" });

  useEffect(() => {
    if (!config.live || !config.configured || !auth) return undefined;
    const enableSound = () => {
      soundEnabled.current = true;
    };
    window.addEventListener("pointerdown", enableSound, { once: true });
    profileRef.current = auth.user ?? {};
    gatewayRef.current = createGatewayClient(config, auth.getAccessToken);
    setStatus(auth.isLoading ? "authenticating" : auth.user ? "connecting" : "signed-out");
    return () => window.removeEventListener("pointerdown", enableSound);
  }, [auth, config]);

  useEffect(() => {
    if (!config.live || !config.configured || !auth?.user || auth.isLoading || workspaceScopeId)
      return undefined;
    let disposed = false;
    setStatus("discovering");
    void auth
      .getAccessToken()
      .then((token) => {
        if (disposed) return;
        discoveryRef.current = connectWorkspaceDiscovery({
          config,
          token,
          onApplied: (connection, workspaces) => {
            if (disposed) return;
            const discovered = workspaces[0]?.id?.toString();
            if (discovered) {
              workspaceStorage()?.setItem(WORKSPACE_ID_KEY, discovered);
              discoveryRef.current?.dispose();
              discoveryRef.current = null;
              setWorkspaceScopeId(discovered);
              setStatus("connecting");
            } else {
              connectionRef.current = connection;
              setStatus("bootstrap-required");
            }
          },
          onDisconnect: (reason) => {
            if (disposed) return;
            connectionRef.current = null;
            setError(reason instanceof Error ? reason.message : "Workspace discovery failed.");
            setStatus("signed-out");
          },
        });
      })
      .catch((reason) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : "Workspace discovery failed.");
        setStatus("signed-out");
      });
    return () => {
      disposed = true;
      discoveryRef.current?.dispose();
      discoveryRef.current = null;
    };
  }, [auth, config, workspaceScopeId]);

  useEffect(() => {
    if (
      !config.live ||
      !config.configured ||
      !auth?.user ||
      !gatewayRef.current ||
      !workspaceScopeId
    )
      return undefined;
    let disposed = false;
    let retryTimer;
    const connect = async () => {
      setStatus(retryRef.current ? "reconnecting" : "connecting");
      try {
        let cleanupConnection;
        cleanupConnection = await connectTicketedRealtime({
          gateway: gatewayRef.current,
          workspaceId: workspaceScopeId,
          config,
          onChange: (connection) => setData(snapshotRealtime(connection, profileRef.current)),
          onReady: (connection) => {
            connectionRef.current = connection;
            retryRef.current = 0;
            setError("");
            setStatus("ready");
          },
          onNotification: (notification) => {
            const kind = Object.keys(notification.kind ?? {})[0];
            if (soundEnabled.current && (kind === "Mention" || kind === "Reply"))
              playNotificationTone();
          },
          onDisconnect: (reason) => {
            if (disposed) return;
            setError(reason instanceof Error ? reason.message : "Realtime connection interrupted.");
            retryRef.current += 1;
            setStatus("reconnecting");
            cleanupConnection?.();
            retryTimer = window.setTimeout(
              () => void connect(),
              Math.min(30_000, 1000 * 2 ** (retryRef.current - 1)),
            );
          },
        });
        if (disposed) {
          cleanupConnection?.();
          return undefined;
        }
        connectionRef.current = null;
        return cleanupConnection;
      } catch (reason) {
        if (disposed) return undefined;
        connectionRef.current = null;
        setData(EMPTY_DATA);
        setError(reason instanceof Error ? reason.message : "Database authorization failed.");
        if (reason?.status === 403 || reason?.status === 404) {
          workspaceStorage()?.removeItem(WORKSPACE_ID_KEY);
          setWorkspaceScopeId("");
          setStatus("discovering");
        } else {
          setStatus("signed-out");
        }
        return undefined;
      }
    };
    let cleanup;
    void connect().then((value) => {
      cleanup = value;
    });
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      cleanup?.();
    };
  }, [auth, config, workspaceScopeId]);

  useEffect(() => {
    if (!selectedWorkspaceId && data.workspaces[0]) setSelectedWorkspaceId(data.workspaces[0].id);
  }, [data.workspaces, selectedWorkspaceId]);
  useEffect(() => {
    const available = data.spaces.filter((space) => space.workspaceId === selectedWorkspaceId);
    if (!available.some((space) => space.id === selectedSpaceId))
      setSelectedSpaceId(available[0]?.id ?? "");
  }, [data.spaces, selectedSpaceId, selectedWorkspaceId]);

  const signIn = useCallback(() => {
    setError("");
    // WorkOS staging stores its refresh token in localStorage. A failed or interrupted
    // callback can leave that disposable token unusable, so an explicit sign-in starts
    // a fresh PKCE session. Production custom-domain mode never touches localStorage.
    if (config.devMode) {
      window.localStorage.removeItem(`workos:refresh-token:${config.clientId}`);
      window.localStorage.removeItem("workos:refresh-token");
    }
    return auth?.signIn({ state: { returnTo: "/" } });
  }, [auth, config.clientId, config.devMode]);
  const signOut = useCallback(() => {
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    discoveryRef.current?.dispose();
    discoveryRef.current = null;
    setData(EMPTY_DATA);
    searchRequestRef.current += 1;
    searchCursorRef.current = undefined;
    setSearchState({ status: "idle", items: [], nextCursor: undefined, error: "" });
    setFileState({ status: "idle", name: "", error: "" });
    setStatus("signed-out");
    auth?.signOut({ returnTo: config.signOutUri });
  }, [auth, config.signOutUri]);
  const bootstrapWorkspace = useCallback(async () => {
    if (!connectionRef.current) throw new Error("Workspace bootstrap connection is unavailable.");
    const user = profileRef.current;
    const displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Parrot Owner";
    setStatus("bootstrapping");
    try {
      await bootstrapOwner(connectionRef.current, displayName, "Parrot");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Workspace bootstrap failed.");
      setStatus("bootstrap-required");
      throw reason;
    }
  }, []);
  const createPost = useCallback(
    async ({ title, body }) => {
      if (!connectionRef.current || !selectedSpaceId)
        throw new Error("Choose a space before publishing.");
      await connectionRef.current.reducers.createPost({
        spaceId: uuid(selectedSpaceId),
        title,
        body,
        clientRequestId: randomUuid(),
      });
    },
    [selectedSpaceId],
  );
  const markNotificationRead = useCallback(async (notificationId) => {
    if (!connectionRef.current) return;
    await connectionRef.current.reducers.markNotificationRead({
      notificationId: uuid(notificationId),
    });
  }, []);
  const search = useCallback(
    async (query, { append = false } = {}) => {
      const requestId = ++searchRequestRef.current;
      const normalized = query.trim();
      if (!normalized || !gatewayRef.current || !selectedWorkspaceId) {
        searchCursorRef.current = undefined;
        setSearchState({ status: "idle", items: [], nextCursor: undefined, error: "" });
        return;
      }
      const cursor = append ? searchCursorRef.current : undefined;
      setSearchState((current) => ({ ...current, status: "loading", error: "" }));
      try {
        const result = await gatewayRef.current.search({
          workspaceId: selectedWorkspaceId,
          query: normalized,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        });
        if (requestId !== searchRequestRef.current) return;
        searchCursorRef.current = result.nextCursor;
        setSearchState((current) => ({
          status: "ready",
          items: append ? [...current.items, ...result.items] : [...result.items],
          nextCursor: result.nextCursor,
          error: "",
        }));
      } catch (reason) {
        if (requestId !== searchRequestRef.current) return;
        setSearchState((current) => ({
          ...current,
          status: "error",
          error: reason instanceof Error ? reason.message : "Search failed.",
        }));
      }
    },
    [selectedWorkspaceId],
  );
  const uploadFile = useCallback(
    async (file) => {
      if (!gatewayRef.current || !selectedWorkspaceId || !selectedSpaceId)
        throw new Error("Choose a space before uploading.");
      setFileState({ status: "uploading", name: file.name, error: "" });
      try {
        await uploadFileWithCapability({
          gateway: gatewayRef.current,
          workspaceId: selectedWorkspaceId,
          spaceId: selectedSpaceId,
          file,
        });
        setFileState({ status: "quarantined", name: file.name, error: "" });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "Upload failed.";
        setFileState({ status: "error", name: file.name, error: message });
        throw reason;
      }
    },
    [selectedSpaceId, selectedWorkspaceId],
  );
  const downloadFile = useCallback(async (fileId) => {
    if (!gatewayRef.current) return;
    setFileState({ status: "downloading", name: "", error: "" });
    try {
      const result = await gatewayRef.current.fileDownload(fileId);
      window.location.assign(result.capability.url);
      setFileState({ status: "idle", name: "", error: "" });
    } catch (reason) {
      setFileState({
        status: "error",
        name: "",
        error: reason instanceof Error ? reason.message : "Download failed.",
      });
    }
  }, []);
  const createThread = useCallback(async (postId, title) => {
    if (!connectionRef.current) throw new Error("Realtime connection is unavailable.");
    await createNamedThread(connectionRef.current, postId, title);
  }, []);
  const replyToThread = useCallback(async (threadId, body) => {
    if (!connectionRef.current) throw new Error("Realtime connection is unavailable.");
    await addThreadReply(connectionRef.current, threadId, body);
  }, []);

  return {
    live: config.live,
    configured: config.configured !== false,
    status,
    error,
    data,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedSpaceId,
    setSelectedSpaceId,
    signIn,
    signOut,
    bootstrapWorkspace,
    createPost,
    markNotificationRead,
    search,
    searchState,
    uploadFile,
    downloadFile,
    fileState,
    createThread,
    replyToThread,
    gateway: gatewayRef.current,
  };
}
