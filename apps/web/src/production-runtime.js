import { ProjectConversationClient } from "@project-conversation/client-sdk";
import { DbConnection } from "@project-conversation/db-bindings";
import { Uuid } from "spacetimedb";

const DEFAULT_CLIENT_ID = "client_01KNAKHWDENJZH10KDPEYAMZMN";
const DEFAULT_GATEWAY_URL = "https://parrotapi.skylarenns.com";

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readProductionConfig(env = import.meta.env, location = window.location) {
  const live = env.MODE !== "test" && (env.PROD || env.VITE_PARROT_LIVE === "true");
  if (!live) return { live: false };

  const apiHostname = trim(env.VITE_WORKOS_API_HOSTNAME)
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const devMode = env.VITE_WORKOS_DEV_MODE === "true";
  const clientId = trim(env.VITE_WORKOS_CLIENT_ID) || DEFAULT_CLIENT_ID;
  const spacetimeUri = trim(env.VITE_SPACETIMEDB_URI);
  const databaseName = trim(env.VITE_SPACETIMEDB_DATABASE_NAME);
  const gatewayUrl = trim(env.VITE_GATEWAY_URL) || DEFAULT_GATEWAY_URL;
  const workspaceId = trim(env.VITE_PARROT_WORKSPACE_ID);
  const missing = [
    ...(devMode ? [] : [["VITE_WORKOS_API_HOSTNAME", apiHostname]]),
    ["VITE_SPACETIMEDB_URI", spacetimeUri],
    ["VITE_SPACETIMEDB_DATABASE_NAME", databaseName],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  return {
    live: true,
    configured: missing.length === 0,
    missing,
    apiHostname,
    devMode,
    clientId,
    spacetimeUri,
    databaseName,
    gatewayUrl,
    workspaceId,
    redirectUri: `${location.origin}/callback`,
    signOutUri: `${location.origin}/signed-out`,
  };
}

export function connectWorkspaceDiscovery({ config, token, onApplied, onDisconnect }) {
  let disposed = false;
  const connection = DbConnection.builder()
    .withUri(config.spacetimeUri)
    .withDatabaseName(config.databaseName)
    .withToken(token)
    .withConfirmedReads(true)
    .onConnect((connected) => {
      const notify = () => onApplied(connected, Array.from(connected.db.myWorkspaces.iter()));
      connected.db.myWorkspaces.onInsert(notify);
      connected
        .subscriptionBuilder()
        .onApplied(notify)
        .onError((_ctx, error) => onDisconnect(error))
        .subscribe(["SELECT * FROM current_user", "SELECT * FROM my_workspaces"]);
    })
    .onConnectError((_ctx, error) => onDisconnect(error))
    .onDisconnect((_ctx, error) => !disposed && onDisconnect(error))
    .build();
  return {
    connection,
    dispose() {
      disposed = true;
      connection.disconnect();
    },
  };
}

export function bootstrapOwner(connection, displayName, workspaceName = "Parrot") {
  return connection.reducers.bootstrapOwner({
    displayName,
    workspaceName,
    clientRequestId: randomUuid(),
  });
}

export function createGatewayClient(config, getAccessToken) {
  return new ProjectConversationClient({
    baseUrl: config.gatewayUrl,
    accessToken: getAccessToken,
  });
}

export const LIVE_QUERIES = Object.freeze([
  "SELECT * FROM current_gateway_principal",
  "SELECT * FROM my_workspaces",
  "SELECT * FROM my_workspace_memberships",
  "SELECT * FROM visible_spaces",
  "SELECT * FROM visible_posts",
  "SELECT * FROM visible_named_threads",
  "SELECT * FROM visible_contributions",
  "SELECT * FROM my_notifications",
  "SELECT * FROM visible_files",
  "SELECT * FROM visible_workspace_members",
  "SELECT * FROM visible_presence",
  "SELECT * FROM my_notification_preferences",
]);

export function connectRealtime({
  config,
  token,
  onReady,
  onChange,
  onDisconnect,
  onNotification,
}) {
  let hydrated = false;
  let disposed = false;
  let refreshTimer;
  const scheduleChange = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => !disposed && onChange(connection), 25);
  };
  const connection = DbConnection.builder()
    .withUri(config.spacetimeUri)
    .withDatabaseName(config.databaseName)
    .withToken(token)
    .withConfirmedReads(true)
    .onConnect((connected) => {
      const tables = [
        connected.db.myWorkspaces,
        connected.db.visibleSpaces,
        connected.db.visiblePosts,
        connected.db.visibleNamedThreads,
        connected.db.visibleContributions,
        connected.db.myNotifications,
        connected.db.visibleFiles,
      ];
      for (const table of tables) {
        table.onInsert(scheduleChange);
        table.onUpdate(scheduleChange);
        table.onDelete(scheduleChange);
      }
      connected.db.myNotifications.onInsert((_ctx, row) => {
        if (hydrated) onNotification(row);
      });
      connected
        .subscriptionBuilder()
        .onApplied(() => {
          hydrated = true;
          onChange(connected);
          onReady(connected);
        })
        .onError((_ctx, error) => onDisconnect(error))
        .subscribe(LIVE_QUERIES);
    })
    .onConnectError((_ctx, error) => onDisconnect(error))
    .onDisconnect((_ctx, error) => !disposed && onDisconnect(error))
    .build();

  return () => {
    disposed = true;
    window.clearTimeout(refreshTimer);
    connection.disconnect();
  };
}

export async function connectTicketedRealtime({
  gateway,
  workspaceId,
  connect = connectRealtime,
  ...connectionOptions
}) {
  const ticket = await gateway.databaseToken(workspaceId);
  return connect({ ...connectionOptions, token: ticket.token });
}

export async function checksumSha256(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadFileWithCapability({
  gateway,
  workspaceId,
  spaceId,
  file,
  fetcher = fetch,
}) {
  const checksumSha256Value = await checksumSha256(file);
  const pending = await gateway.createUpload({
    workspaceId,
    spaceId,
    displayName: file.name,
    declaredContentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    checksumSha256: checksumSha256Value,
  });
  const response = await fetcher(pending.capability.url, {
    method: pending.capability.method,
    headers: pending.capability.requiredHeaders,
    body: file,
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`Object storage rejected the upload (${response.status}).`);
  return gateway.completeUpload(pending.uploadId);
}

export function createNamedThread(connection, postId, title) {
  return connection.reducers.createNamedThread({
    rootPostId: uuid(postId),
    title,
    clientRequestId: randomUuid(),
  });
}

export function addThreadReply(connection, threadId, body) {
  return connection.reducers.addContribution({
    threadId: uuid(threadId),
    parentContributionId: undefined,
    kind: { tag: "Message" },
    body,
    clientRequestId: randomUuid(),
  });
}

export function uuid(value) {
  return Uuid.parse(value);
}

export function randomUuid() {
  return Uuid.fromRandomBytesV4(crypto.getRandomValues(new Uint8Array(16)));
}
