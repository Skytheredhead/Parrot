export type ResourceKind =
  | "workspace"
  | "space"
  | "file"
  | "message"
  | "post"
  | "task"
  | "dm"
  | "agent_run"
  | "tool";

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface DatabaseToken {
  token: string;
  expiresAt: string;
}

export interface UploadConstraints {
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  singleWrite: true;
}

export interface UploadCapability {
  url: string;
  method: "PUT";
  expiresAt: string;
  requiredHeaders: Readonly<Record<string, string>>;
  constraints: UploadConstraints;
}

export interface CreateUploadInput {
  workspaceId: string;
  spaceId: string;
  displayName: string;
  declaredContentType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface PendingUpload {
  uploadId: string;
  lifecycle: "pending";
  capability: UploadCapability;
}

export interface QuarantinedUpload {
  uploadId: string;
  lifecycle: "quarantined";
}

export interface DownloadCapability {
  url: string;
  expiresAt: string;
  objectVersion: string;
}

export interface FileDownload {
  fileId: string;
  contentType: string;
  sizeBytes: number;
  capability: DownloadCapability;
}

export interface SearchInput {
  workspaceId: string;
  query: string;
  limit?: number;
  cursor?: string;
}

export interface SearchResult {
  items: readonly {
    kind: ResourceKind;
    id: string;
    workspaceId: string;
    title: string;
    snippet: string;
    occurredAt: string;
    source: "human" | "agent" | "service";
  }[];
  nextCursor?: string;
}

export type InvitationRole = "admin" | "member" | "guest";

export interface CreateInvitationInput {
  workspaceId: string;
  role: InvitationRole;
  spaceIds?: readonly string[];
  email?: string;
  expiresInSeconds?: number;
  useLimit?: number;
}

export interface CreatedInvitation {
  invitationId: string;
  /** One-time bearer material. Keep in memory and send only through an approved channel. */
  token: string;
  expiresAt: string;
  useLimit: number;
}

export interface RedeemedInvitation {
  status: "accepted";
  workspaceId: string;
  membershipId: string;
  role: InvitationRole;
  useCount: number;
  useLimit: number;
}

export interface UserSession {
  sessionId: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  kind: "browser" | "api";
}

export interface SessionList {
  sessions: readonly UserSession[];
}

export interface SessionRevocation {
  revoked: true;
  revokedCount?: number;
}

export interface AgentStreamTicket {
  token: string;
  expiresAt: string;
  streamUrl: string;
}

export interface AgentToolResult {
  invocationId: string;
  status: "accepted" | "completed";
  output?: unknown;
}

export interface GatewayErrorBody {
  error: { code: string; message: string };
  requestId: string;
}
