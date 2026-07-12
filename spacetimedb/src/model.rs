use crate::reducers::{
    drain_workspace_lifecycle_schedule, expire_presence_schedule, expire_workspace_export_schedule,
};
use spacetimedb::{Identity, SpacetimeType, Timestamp, Uuid};

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceRole {
    Owner,
    Admin,
    Member,
    Guest,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpaceVisibility {
    Workspace,
    Private,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContributionKind {
    Message,
    Update,
    Summary,
    AgentOutput,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostKind {
    Discussion,
    Question,
    Announcement,
    Decision,
    Task,
    Poll,
    Incident,
    MediaDrop,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostState {
    Active,
    Resolved,
    Archived,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionStatus {
    Proposed,
    Accepted,
    Rejected,
    Superseded,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Todo,
    InProgress,
    Done,
    Canceled,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationKind {
    Mention,
    Assignment,
    Decision,
    Agent,
    System,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationTier {
    Direct,
    Important,
    Ambient,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationDeliveryMode {
    Immediate,
    Digest,
    Disabled,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceStatus {
    Online,
    Away,
    DoNotDisturb,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceDeviceKind {
    Web,
    Desktop,
    Mobile,
    Other,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationDeliveryState {
    Pending,
    Suppressed,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationDigestClaimState {
    Claimed,
    Retry,
    OutcomeUnknown,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationDigestCompletionOutcome {
    Succeeded,
    Suppressed,
    TransientFailure,
    PermanentFailure,
    OutcomeUnknown,
    ReconciliationUnknown,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationDigestTerminalOutcome {
    Succeeded,
    Suppressed,
    PermanentFailure,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentCapability {
    ReadSpace,
    ReadHistory,
    WriteContribution,
    UseReadTool,
    UseExternalTool,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolEffectClass {
    Read,
    External,
    Destructive,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectLedgerState {
    Pending,
    Acquired,
    Succeeded,
    Failed,
    OutcomeUnknown,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileSecurityState {
    UploadPending,
    Uploaded,
    Scanning,
    Clean,
    Rejected,
    Extracted,
    Deleted,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentRunState {
    Queued,
    Authorizing,
    CollectingContext,
    Running,
    AwaitingApproval,
    ExecutingTool,
    Succeeded,
    Failed,
    Canceled,
    Expired,
    Revoked,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCallState {
    Proposed,
    AwaitingApproval,
    Approved,
    Executing,
    Succeeded,
    Failed,
    OutcomeUnknown,
    Canceled,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalState {
    Pending,
    Approved,
    Rejected,
    Expired,
    Consumed,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DmPromotionState {
    Pending,
    Rejected,
    Canceled,
    Expired,
    Finalized,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum DmPromotionDecision {
    Approve,
    Reject,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboxState {
    Pending,
    Leased,
    Succeeded,
    Retry,
    OutcomeUnknown,
    DeadLetter,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceLifecycleState {
    Active,
    DeletionRequested,
    DeletionFenced,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceLegalHoldState {
    Active,
    Released,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceExportState {
    Requested,
    Ready,
    Failed,
    Expired,
    Cleaned,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceExportCompletionOutcome {
    Ready,
    Retry,
    OutcomeUnknown,
    Failed,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceExportCleanupOutcome {
    Deleted,
    NotFound,
    Retry,
    OutcomeUnknown,
    Failed,
}

#[derive(SpacetimeType)]
pub struct CreateTypedPostInput {
    pub space_id: Uuid,
    pub title: String,
    pub body: String,
    pub kind: PostKind,
    pub owner_identity: Identity,
    pub assignee_identity: Option<Identity>,
    pub tags: Vec<String>,
    pub mentions: Vec<Identity>,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct UpdatePostLifecycleInput {
    pub post_id: Uuid,
    pub state: PostState,
    pub locked: bool,
    pub owner_identity: Identity,
    pub assignee_identity: Option<Identity>,
    pub expected_revision: u64,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct ConfigurePollInput {
    pub post_id: Uuid,
    pub options: Vec<String>,
    pub allows_multiple: bool,
    pub expected_post_revision: u64,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct InstallAgentInput {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub secret_ref: String,
    pub max_run_tokens: u64,
    pub max_run_cost_micros: u64,
    pub max_attempts: u32,
    pub max_age_seconds: u32,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct AgentToolCallInput {
    pub run_id: Uuid,
    pub lease_generation: u64,
    pub expected_version: u64,
    pub tool_name: String,
    pub tool_version: String,
    pub normalized_args_hash: String,
    pub approval_nonce_hash: String,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct SetAgentToolPolicyInput {
    pub installation_id: Uuid,
    pub tool_name: String,
    pub tool_version: String,
    pub capability: AgentCapability,
    pub requires_approval: bool,
    pub approval_ttl_seconds: u32,
    pub enabled: bool,
    pub expected_installation_epoch: u64,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct CompleteAgentRunInput {
    pub run_id: Uuid,
    pub lease_generation: u64,
    pub expected_version: u64,
    pub succeeded: bool,
    pub output_summary: String,
    pub used_tokens: u64,
    pub used_cost_micros: u64,
}

#[derive(SpacetimeType)]
pub struct AgentContextPostInput {
    pub run_id: Uuid,
    pub lease_generation: u64,
    pub post_id: Uuid,
    pub expected_revision: u64,
    pub source_hash: String,
    pub trust_class: String,
    pub redaction_summary: String,
}

#[derive(SpacetimeType)]
pub struct AgentContextContributionInput {
    pub run_id: Uuid,
    pub lease_generation: u64,
    pub contribution_id: Uuid,
    pub expected_revision: u64,
    pub source_hash: String,
    pub trust_class: String,
    pub redaction_summary: String,
}

#[derive(SpacetimeType)]
pub struct FileUploadInput {
    pub space_id: Uuid,
    pub file_name: String,
    pub declared_size_bytes: u64,
    pub checksum: String,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct FileScanOutcomeInput {
    pub job_id: Uuid,
    pub lease_generation: u64,
    pub file_id: Uuid,
    pub expected_revision: u64,
    pub detected_type: String,
    pub clean: bool,
    pub clean_key: String,
    pub scanner: String,
}

#[derive(SpacetimeType)]
pub struct FileExtractionInput {
    pub job_id: Uuid,
    pub lease_generation: u64,
    pub file_id: Uuid,
    pub expected_revision: u64,
    pub extracted_text: String,
}

#[derive(SpacetimeType)]
pub struct CreateDirectConversationInput {
    pub workspace_id: Uuid,
    pub participants: Vec<Identity>,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct ProposeDmPromotionInput {
    pub conversation_id: Uuid,
    pub destination_space_id: Uuid,
    pub title: String,
    pub body: String,
    pub source_message_ids: Vec<Uuid>,
    pub expires_in_seconds: u32,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct HeartbeatPresenceInput {
    pub workspace_id: Uuid,
    pub session_id: Uuid,
    pub device_kind: PresenceDeviceKind,
    pub device_label: String,
    pub status: PresenceStatus,
    pub ttl_seconds: u32,
}

#[derive(SpacetimeType)]
pub struct SetNotificationPreferenceInput {
    pub workspace_id: Uuid,
    pub space_id: Option<Uuid>,
    pub direct_mode: NotificationDeliveryMode,
    pub important_mode: NotificationDeliveryMode,
    pub ambient_mode: NotificationDeliveryMode,
    pub mute_start_local_minute: Option<u16>,
    pub mute_end_local_minute: Option<u16>,
    pub time_zone: String,
    pub digest_local_minute: u16,
    pub expected_revision: u64,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct NotificationDigestOccurrenceInput {
    pub schedule_id: Uuid,
    pub local_date: String,
    pub scheduled_for: Timestamp,
    pub expected_preference_revision: u64,
    pub expected_digest_revision: u64,
}

#[derive(SpacetimeType)]
pub struct ClaimNotificationDigestsInput {
    pub occurrences: Vec<NotificationDigestOccurrenceInput>,
    pub worker_slot_id: String,
    pub lease_seconds: u32,
}

#[derive(SpacetimeType)]
pub struct AuthorizeNotificationDigestInput {
    pub claim_id: Uuid,
    pub worker_slot_id: String,
    pub lease_generation: u64,
    pub permit_seconds: u32,
}

#[derive(SpacetimeType)]
pub struct RecordNotificationDigestOutcomeInput {
    pub claim_id: Uuid,
    pub worker_slot_id: String,
    pub lease_generation: u64,
    pub outcome: NotificationDigestCompletionOutcome,
    pub reconciled: bool,
    pub provider_reference: String,
    pub code: String,
    pub retry_after_seconds: u32,
}

#[derive(SpacetimeType)]
pub struct ConfigureWorkspaceLifecycleInput {
    pub workspace_id: Uuid,
    pub deleted_content_retention_days: Option<u32>,
    pub deletion_grace_days: Option<u16>,
    pub expected_revision: u64,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct WorkspaceLifecycleCommandInput {
    pub workspace_id: Uuid,
    pub expected_revision: u64,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct PlaceWorkspaceLegalHoldInput {
    pub workspace_id: Uuid,
    pub reason: String,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct ReleaseWorkspaceLegalHoldInput {
    pub hold_id: Uuid,
    pub expected_revision: u64,
    pub release_reason: String,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct RequestWorkspaceExportInput {
    pub workspace_id: Uuid,
    pub client_request_id: Uuid,
}

#[derive(SpacetimeType)]
pub struct CompleteWorkspaceExportInput {
    pub export_id: Uuid,
    pub job_id: Uuid,
    pub lease_generation: u64,
    pub worker_slot_id: String,
    pub outcome: WorkspaceExportCompletionOutcome,
    pub artifact_key: String,
    pub content_hash: String,
    pub artifact_version: String,
    pub size_bytes: u64,
    pub error: String,
    pub retry_after_seconds: u32,
}

#[derive(SpacetimeType)]
pub struct CompleteWorkspaceExportCleanupInput {
    pub export_id: Uuid,
    pub job_id: Uuid,
    pub lease_generation: u64,
    pub worker_slot_id: String,
    pub outcome: WorkspaceExportCleanupOutcome,
    pub error: String,
    pub retry_after_seconds: u32,
}

#[derive(SpacetimeType)]
pub struct SearchWorkItem {
    pub job_id: Uuid,
    pub effect_key: String,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub acl_revision: u64,
    pub title: String,
    pub body: String,
    pub tombstone: bool,
    pub allowed_identities: Vec<Identity>,
    pub state: OutboxState,
    pub lease_generation: u64,
}

#[derive(SpacetimeType)]
pub struct OutboxJobEnvelopeView {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: String,
    pub effect_key: String,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub acl_revision: Option<u64>,
    pub intent_id: Option<Uuid>,
    pub recipient_id: Option<Identity>,
    pub channel: String,
    pub authorization_epoch: Option<u64>,
    pub minimal_message: String,
    pub payload_resource_id: Option<Uuid>,
    pub rebuild_id: Option<Uuid>,
    pub generation: Option<u64>,
    pub file_id: Option<Uuid>,
    pub version: Option<u64>,
    pub run_id: Option<Uuid>,
    pub created_at: Timestamp,
    pub next_attempt_at: Timestamp,
    pub attempt: u32,
    pub state: OutboxState,
    pub lease_owner: Option<Identity>,
    pub worker_slot_id: String,
    pub lease_until: Option<Timestamp>,
    pub lease_generation: u64,
    pub last_error: String,
}

#[derive(SpacetimeType)]
pub struct AgentContextCandidate {
    pub run_id: Uuid,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub title: String,
    pub body: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = auth_policy, private)]
pub struct AuthPolicy {
    #[primary_key]
    pub singleton: u8,
    pub issuer: String,
    pub audience: String,
    pub configured_by: Identity,
    pub configured_at: Timestamp,
}

#[spacetimedb::table(accessor = bootstrap_authority, private)]
pub struct BootstrapAuthority {
    #[primary_key]
    pub singleton: u8,
    pub issuer: String,
    pub audience: String,
    pub owner_subject: String,
    pub consumed: bool,
    pub configured_at: Timestamp,
}

#[spacetimedb::table(accessor = platform_authority, private)]
pub struct PlatformAuthority {
    #[primary_key]
    pub singleton: u8,
    pub operator_subject: String,
    pub revision: u64,
    pub updated_by: Identity,
    pub configured_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = pending_operator_transfer, private)]
pub struct PendingOperatorTransfer {
    #[primary_key]
    pub singleton: u8,
    pub proposed_subject: String,
    pub authority_revision: u64,
    pub proposed_by: Identity,
    pub proposed_at: Timestamp,
    pub expires_at: Timestamp,
}

#[spacetimedb::table(accessor = platform_command_receipt, private)]
pub struct PlatformCommandReceipt {
    #[primary_key]
    pub key: String,
    pub operation: String,
    pub client_request_id: Uuid,
    pub input_hash: String,
    pub actor_subject: String,
    pub committed_revision: u64,
    pub committed_at: Timestamp,
}

#[spacetimedb::table(accessor = platform_audit_log, private)]
pub struct PlatformAuditLog {
    #[primary_key]
    pub id: Uuid,
    pub actor_identity: Identity,
    pub actor_subject: String,
    #[index(btree)]
    pub workspace_id: Option<Uuid>,
    pub action: String,
    pub resource: String,
    pub request_id: Uuid,
    pub summary: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = user, private)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub display_name: String,
    pub disabled: bool,
    pub authz_epoch: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = workspace, private)]
pub struct Workspace {
    #[primary_key]
    pub id: Uuid,
    pub name: String,
    pub owner_identity: Identity,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = workspace_lifecycle, private)]
#[derive(Clone)]
pub struct WorkspaceLifecycle {
    #[primary_key]
    pub workspace_id: Uuid,
    pub state: WorkspaceLifecycleState,
    pub lifecycle_epoch: u64,
    pub deleted_content_retention_days: Option<u32>,
    pub deletion_grace_days: Option<u16>,
    pub deletion_requested_by: Option<Identity>,
    pub deletion_requested_at: Option<Timestamp>,
    pub deletion_execute_after: Option<Timestamp>,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(
    accessor = workspace_lifecycle_drain_schedule,
    private,
    scheduled(drain_workspace_lifecycle_schedule)
)]
pub struct WorkspaceLifecycleDrainSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: spacetimedb::ScheduleAt,
    #[unique]
    pub workspace_id: Uuid,
    pub lifecycle_epoch: u64,
}

#[spacetimedb::table(
    accessor = workspace_legal_hold,
    private,
    index(accessor = workspace_state, btree(columns = [workspace_id, state]))
)]
pub struct WorkspaceLegalHold {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub state: WorkspaceLegalHoldState,
    pub reason: String,
    pub placed_by_identity: Identity,
    pub placed_by_subject: String,
    pub placed_at: Timestamp,
    pub released_by_identity: Option<Identity>,
    pub released_by_subject: String,
    pub release_reason: String,
    pub released_at: Option<Timestamp>,
    pub revision: u64,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(
    accessor = workspace_export,
    private,
    index(accessor = workspace_state, btree(columns = [workspace_id, state]))
)]
#[derive(Clone)]
pub struct WorkspaceExport {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub requested_by: Identity,
    #[index(btree)]
    pub state: WorkspaceExportState,
    pub lifecycle_epoch: u64,
    pub workspace_revision: u64,
    pub artifact_key: String,
    pub content_hash: String,
    pub artifact_version: String,
    pub size_bytes: u64,
    pub expires_at: Option<Timestamp>,
    pub failure_reason: String,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(
    accessor = workspace_export_expiry_schedule,
    private,
    scheduled(expire_workspace_export_schedule)
)]
pub struct WorkspaceExportExpirySchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: spacetimedb::ScheduleAt,
    #[unique]
    pub export_id: Uuid,
    pub expected_revision: u64,
}

#[spacetimedb::table(accessor = workspace_member, private)]
pub struct WorkspaceMember {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub role: WorkspaceRole,
    pub active: bool,
    pub authz_epoch: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = space, private)]
#[derive(Clone)]
pub struct Space {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub name: String,
    pub visibility: SpaceVisibility,
    pub archived: bool,
    pub revision: u64,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = space_member, private)]
pub struct SpaceMember {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub space_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub active: bool,
    pub authz_epoch: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = post, private)]
#[derive(Clone)]
pub struct Post {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub space_id: Uuid,
    pub author_identity: Identity,
    pub owner_identity: Identity,
    pub assignee_identity: Option<Identity>,
    pub kind: PostKind,
    pub state: PostState,
    pub locked: bool,
    pub title: String,
    pub body: String,
    pub revision: u64,
    pub activity_sequence: u64,
    pub last_activity_at: Timestamp,
    pub deleted: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = post_tag, private)]
pub struct PostTag {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub post_id: Uuid,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub tag: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = post_mention, private)]
pub struct PostMention {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub post_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = post_reaction, private)]
pub struct PostReaction {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub post_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub emoji: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = post_user_state, private)]
pub struct PostUserState {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub post_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub following: bool,
    pub bookmarked: bool,
    pub last_read_sequence: u64,
    pub read_at: Option<Timestamp>,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = post_pin, private)]
pub struct PostPin {
    #[primary_key]
    pub post_id: Uuid,
    pub workspace_id: Uuid,
    #[index(btree)]
    pub space_id: Uuid,
    pub pinned_by: Identity,
    pub pinned_at: Timestamp,
}

#[spacetimedb::table(accessor = post_activity, private)]
pub struct PostActivity {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub post_id: Uuid,
    pub sequence: u64,
    pub actor_identity: Identity,
    pub kind: String,
    pub summary: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = poll, private)]
pub struct Poll {
    #[primary_key]
    pub post_id: Uuid,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub allows_multiple: bool,
    pub closed: bool,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = poll_option, private)]
pub struct PollOption {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub post_id: Uuid,
    pub label: String,
    pub position: u32,
}

#[spacetimedb::table(accessor = poll_vote, private)]
pub struct PollVote {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub post_id: Uuid,
    #[index(btree)]
    pub option_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = named_thread, private)]
#[derive(Clone)]
pub struct NamedThread {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub space_id: Uuid,
    #[index(btree)]
    pub root_post_id: Uuid,
    pub title: String,
    pub archived: bool,
    pub revision: u64,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = contribution, private)]
#[derive(Clone)]
pub struct Contribution {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub thread_id: Uuid,
    #[index(btree)]
    pub author_identity: Identity,
    pub agent_installation_id: Option<Uuid>,
    pub agent_run_id: Option<Uuid>,
    pub parent_contribution_id: Option<Uuid>,
    pub kind: ContributionKind,
    pub body: String,
    pub revision: u64,
    pub deleted: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = reply_ancestry, private)]
pub struct ReplyAncestry {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub ancestor_id: Uuid,
    #[index(btree)]
    pub descendant_id: Uuid,
    pub thread_id: Uuid,
    pub depth: u32,
}

#[spacetimedb::table(accessor = direct_conversation, private)]
#[derive(Clone)]
pub struct DirectConversation {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub created_by: Identity,
    pub next_sequence: u64,
    pub revision: u64,
    pub deactivated_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = direct_participant, private)]
#[derive(Clone)]
pub struct DirectParticipant {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub conversation_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub workspace_id: Uuid,
    pub joined_at: Timestamp,
    pub left_at: Option<Timestamp>,
    pub participant_epoch: u64,
}

#[spacetimedb::table(accessor = direct_message, private)]
#[derive(Clone)]
pub struct DirectMessage {
    #[primary_key]
    pub id: Uuid,
    #[unique]
    pub sequence_key: String,
    #[index(btree)]
    pub conversation_id: Uuid,
    #[index(btree)]
    pub author_identity: Identity,
    pub workspace_id: Uuid,
    pub sequence: u64,
    pub parent_message_id: Option<Uuid>,
    pub body: String,
    pub revision: u64,
    pub deleted: bool,
    pub created_at: Timestamp,
    pub edited_at: Option<Timestamp>,
    pub deleted_at: Option<Timestamp>,
}

#[spacetimedb::table(accessor = direct_reply_ancestry, private)]
pub struct DirectReplyAncestry {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub ancestor_message_id: Uuid,
    #[index(btree)]
    pub descendant_message_id: Uuid,
    #[index(btree)]
    pub conversation_id: Uuid,
    pub depth: u32,
}

#[spacetimedb::table(accessor = direct_read_state, private)]
pub struct DirectReadState {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub conversation_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub last_read_sequence: u64,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = dm_promotion_proposal, private)]
#[derive(Clone)]
pub struct DmPromotionProposal {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub conversation_id: Uuid,
    pub workspace_id: Uuid,
    pub destination_space_id: Uuid,
    pub proposer_identity: Identity,
    pub title: String,
    pub body: String,
    pub draft_hash: String,
    pub source_revision_hash: String,
    pub proposal_hash: String,
    pub participant_epoch_hash: String,
    pub state: DmPromotionState,
    pub revision: u64,
    pub expires_at: Timestamp,
    pub finalized_post_id: Option<Uuid>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = dm_promotion_source, private)]
pub struct DmPromotionSource {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub proposal_id: Uuid,
    #[index(btree)]
    pub message_id: Uuid,
    pub message_revision: u64,
    pub ordinal: u32,
}

#[spacetimedb::table(accessor = dm_promotion_consent, private)]
pub struct DmPromotionConsent {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub proposal_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub decision: DmPromotionDecision,
    pub proposal_hash: String,
    pub decided_at: Timestamp,
}

#[spacetimedb::table(accessor = decision_record, private)]
#[derive(Clone)]
pub struct DecisionRecord {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub thread_id: Uuid,
    pub title: String,
    pub rationale: String,
    pub status: DecisionStatus,
    pub supersedes_decision_id: Option<Uuid>,
    pub created_by: Identity,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = task_item, private)]
#[derive(Clone)]
pub struct TaskItem {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub thread_id: Option<Uuid>,
    #[index(btree)]
    pub assignee_identity: Identity,
    pub title: String,
    pub status: TaskStatus,
    pub created_by: Identity,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification, private)]
pub struct Notification {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub recipient_identity: Identity,
    pub kind: NotificationKind,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub summary: String,
    pub read_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_control, private)]
pub struct NotificationControl {
    #[primary_key]
    pub notification_id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub recipient_identity: Identity,
    pub space_id: Option<Uuid>,
    pub tier: NotificationTier,
    pub event_class: NotificationKind,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub group_key: String,
    pub group_revision: u64,
    pub occurrence_count: u64,
    pub membership_epoch: u64,
    pub preference_revision: u64,
    pub channel: String,
    pub delivery_state: NotificationDeliveryState,
    pub suppression_reason: String,
    pub window_started_at: Timestamp,
    pub window_expires_at: Timestamp,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_group, private)]
pub struct NotificationGroup {
    #[primary_key]
    pub base_key: String,
    pub group_key: String,
    pub notification_id: Uuid,
    pub group_revision: u64,
    pub window_started_at: Timestamp,
    pub window_expires_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_delivery_permit, private)]
pub struct NotificationDeliveryPermit {
    #[primary_key]
    pub job_id: Uuid,
    pub notification_id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub service_identity: Identity,
    pub worker_slot_id: String,
    pub lease_generation: u64,
    pub group_key: String,
    pub group_revision: u64,
    pub resource_revision: u64,
    pub membership_epoch: u64,
    pub preference_revision: u64,
    pub channel: String,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_preference, private)]
pub struct NotificationPreference {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub identity: Identity,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub space_id: Option<Uuid>,
    pub direct_mode: NotificationDeliveryMode,
    pub important_mode: NotificationDeliveryMode,
    pub ambient_mode: NotificationDeliveryMode,
    pub mute_start_local_minute: Option<u16>,
    pub mute_end_local_minute: Option<u16>,
    pub time_zone: String,
    pub digest_local_minute: u16,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_digest_schedule, private)]
#[derive(Clone)]
pub struct NotificationDigestSchedule {
    #[primary_key]
    pub id: Uuid,
    #[unique]
    pub key: String,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub recipient_identity: Identity,
    pub preference_key: String,
    pub channel: String,
    pub time_zone: String,
    pub digest_local_minute: u16,
    pub preference_revision: u64,
    pub digest_revision: u64,
    pub overflow_count: u64,
    pub overflow_revision: u64,
    pub last_occurrence_local_date: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_digest_item, private)]
pub struct NotificationDigestItem {
    #[primary_key]
    pub notification_id: Uuid,
    #[index(btree)]
    pub schedule_id: Uuid,
    pub digest_revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_digest_claim, private)]
#[derive(Clone)]
pub struct NotificationDigestClaim {
    #[primary_key]
    pub claim_id: Uuid,
    #[unique]
    pub schedule_id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub recipient_identity: Identity,
    pub channel: String,
    pub local_date: String,
    pub scheduled_for: Timestamp,
    pub preference_revision: u64,
    pub digest_revision: u64,
    pub authorization_epoch: u64,
    pub overflow_count: u64,
    pub state: NotificationDigestClaimState,
    pub service_identity: Identity,
    pub worker_slot_id: String,
    pub lease_generation: u64,
    pub lease_until: Timestamp,
    pub attempt_count: u32,
    pub next_attempt_at: Timestamp,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_digest_permit, private)]
pub struct NotificationDigestPermit {
    #[primary_key]
    pub claim_id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub schedule_id: Uuid,
    pub service_identity: Identity,
    pub worker_slot_id: String,
    pub lease_generation: u64,
    pub preference_revision: u64,
    pub digest_revision: u64,
    pub authorization_epoch: u64,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = notification_digest_outcome, private)]
pub struct NotificationDigestOutcome {
    #[primary_key]
    pub occurrence_key: String,
    #[index(btree)]
    pub schedule_id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub local_date: String,
    pub digest_revision: u64,
    pub outcome: NotificationDigestTerminalOutcome,
    pub provider_reference: String,
    pub code: String,
    pub completed_at: Timestamp,
}

#[spacetimedb::table(accessor = presence_session, private)]
pub struct PresenceSession {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub scope_key: String,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub session_id: Uuid,
    pub device_kind: PresenceDeviceKind,
    pub device_label: String,
    pub status: PresenceStatus,
    pub created_at: Timestamp,
    pub heartbeat_at: Timestamp,
    #[index(btree)]
    pub expires_at: Timestamp,
}

#[spacetimedb::table(accessor = current_presence, private)]
pub struct CurrentPresence {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub identity: Identity,
    pub status: PresenceStatus,
    pub expires_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = presence_expiry_schedule, private, scheduled(expire_presence_schedule))]
pub struct PresenceExpirySchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: spacetimedb::ScheduleAt,
    #[unique]
    pub presence_key: String,
    pub expected_expires_at: Timestamp,
}

#[derive(SpacetimeType)]
pub struct NotificationDeliveryPlanView {
    pub job_id: Uuid,
    pub notification_id: Uuid,
    pub workspace_id: Uuid,
    pub recipient_identity: Identity,
    pub channel: String,
    pub delivery_state: NotificationDeliveryState,
    pub suppression_reason: String,
    pub group_key: String,
    pub group_revision: u64,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub membership_epoch: u64,
    pub preference_revision: u64,
    pub lease_owner: Option<Identity>,
    pub worker_slot_id: String,
    pub lease_generation: u64,
    pub permit_expires_at: Option<Timestamp>,
}

#[spacetimedb::table(accessor = service_principal, private)]
pub struct ServicePrincipal {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub enabled: bool,
    pub can_run_agents: bool,
    pub can_process_outbox: bool,
    pub authz_epoch: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = service_grant, private)]
pub struct ServiceGrant {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub service_identity: Identity,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub kind: String,
    pub enabled: bool,
    pub authz_epoch: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = agent_installation, private)]
#[derive(Clone)]
pub struct AgentInstallation {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub secret_ref: String,
    pub enabled: bool,
    pub authz_epoch: u64,
    pub max_run_tokens: u64,
    pub max_run_cost_micros: u64,
    pub max_attempts: u32,
    pub max_age_seconds: u32,
    pub installed_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = agent_scope, private)]
pub struct AgentScope {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub installation_id: Uuid,
    pub space_id: Option<Uuid>,
    pub capability: AgentCapability,
    pub enabled: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = agent_tool_policy, private)]
pub struct AgentToolPolicy {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub installation_id: Uuid,
    pub tool_name: String,
    pub tool_version: String,
    pub capability: AgentCapability,
    pub effect_class: ToolEffectClass,
    pub trusted_tool_revision: u64,
    pub requires_approval: bool,
    pub approval_ttl_seconds: u32,
    pub enabled: bool,
    pub revision: u64,
    pub configured_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = trusted_tool, private)]
pub struct TrustedTool {
    #[primary_key]
    pub key: String,
    pub tool_name: String,
    pub tool_version: String,
    pub capability: AgentCapability,
    pub effect_class: ToolEffectClass,
    pub enabled: bool,
    pub revision: u64,
    pub configured_at: Timestamp,
}

#[spacetimedb::table(
    accessor = agent_run,
    private,
    index(accessor = workspace_state, btree(columns = [workspace_id, state]))
)]
#[derive(Clone)]
pub struct AgentRun {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub installation_id: Uuid,
    pub space_id: Uuid,
    pub thread_id: Option<Uuid>,
    pub initiated_by: Identity,
    #[index(btree)]
    pub state: AgentRunState,
    pub version: u64,
    pub installation_epoch: u64,
    pub membership_epoch: u64,
    pub attempt: u32,
    pub cancel_requested: bool,
    pub lease_owner: Option<Identity>,
    pub lease_until: Option<Timestamp>,
    pub lease_generation: u64,
    pub expires_at: Timestamp,
    pub next_event_sequence: u64,
    pub prompt_summary: String,
    pub output_summary: String,
    pub used_tokens: u64,
    pub used_cost_micros: u64,
    pub final_contribution_id: Option<Uuid>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = agent_run_event, private)]
pub struct AgentRunEvent {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub run_id: Uuid,
    pub sequence: u64,
    #[unique]
    pub run_sequence_key: String,
    pub kind: String,
    pub summary: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = agent_context_manifest, private)]
pub struct AgentContextManifest {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub run_id: Uuid,
    #[unique]
    pub run_resource_key: String,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub source_hash: String,
    pub trust_class: String,
    pub redaction_summary: String,
    pub policy_version: u32,
    pub created_at: Timestamp,
}

#[spacetimedb::table(
    accessor = agent_tool_call,
    private,
    index(accessor = run_state, btree(columns = [run_id, state]))
)]
pub struct AgentToolCall {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub run_id: Uuid,
    pub tool_name: String,
    pub tool_version: String,
    pub policy_key: String,
    pub policy_revision: u64,
    pub effect_class: ToolEffectClass,
    pub normalized_args_hash: String,
    #[unique]
    pub effect_key: String,
    pub requires_approval: bool,
    pub state: ToolCallState,
    pub result_summary: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(
    accessor = approval_request,
    private,
    index(accessor = run_state, btree(columns = [run_id, state]))
)]
pub struct ApprovalRequest {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub run_id: Uuid,
    #[unique]
    pub tool_call_id: Uuid,
    pub normalized_args_hash: String,
    pub effect_class: ToolEffectClass,
    pub nonce_hash: String,
    pub state: ApprovalState,
    pub requested_by_service: Identity,
    pub decided_by: Option<Identity>,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
    pub decided_at: Option<Timestamp>,
}

#[spacetimedb::table(accessor = effect_ledger, private)]
pub struct EffectLedger {
    #[primary_key]
    pub effect_key: String,
    #[unique]
    pub tool_call_id: Uuid,
    pub run_id: Uuid,
    pub normalized_args_hash: String,
    pub owner_identity: Option<Identity>,
    pub owner_generation: u64,
    pub state: EffectLedgerState,
    pub provider_reference: String,
    pub result_summary: String,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(
    accessor = outbox_job,
    private,
    index(accessor = workspace_state, btree(columns = [workspace_id, state]))
)]
pub struct OutboxJob {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[unique]
    pub effect_key: String,
    #[index(btree)]
    pub state: OutboxState,
    pub kind: String,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub acl_revision: Option<u64>,
    pub intent_id: Option<Uuid>,
    pub recipient_id: Option<Identity>,
    pub channel: String,
    pub authorization_epoch: Option<u64>,
    pub minimal_message: String,
    pub payload_resource_id: Option<Uuid>,
    pub rebuild_id: Option<Uuid>,
    pub generation: Option<u64>,
    pub file_id: Option<Uuid>,
    pub version: Option<u64>,
    pub run_id: Option<Uuid>,
    pub expires_at: Timestamp,
    pub attempt: u32,
    pub lease_owner: Option<Identity>,
    pub worker_slot_id: String,
    pub lease_until: Option<Timestamp>,
    pub lease_generation: u64,
    pub next_attempt_at: Timestamp,
    pub last_error: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = search_document_snapshot, private)]
pub struct SearchDocumentSnapshot {
    #[primary_key]
    pub effect_key: String,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub resource_revision: u64,
    pub acl_revision: u64,
    pub title: String,
    pub body: String,
    pub tombstone: bool,
    pub allowed_identities: Vec<Identity>,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = file_record, private)]
#[derive(Clone)]
pub struct FileRecord {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    #[index(btree)]
    pub space_id: Uuid,
    pub owner_identity: Identity,
    pub file_name: String,
    pub source_key: String,
    pub clean_key: String,
    pub cleanup_prefix: String,
    pub declared_size_bytes: u64,
    pub checksum: String,
    pub detected_type: String,
    pub scanner: String,
    pub extracted_text: String,
    pub state: FileSecurityState,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = file_version, private)]
pub struct FileVersion {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub file_id: Uuid,
    pub workspace_id: Uuid,
    pub content_version: u64,
    pub source_key: String,
    pub clean_key: String,
    pub declared_size_bytes: u64,
    pub checksum: String,
    pub detected_type: String,
    pub state: FileSecurityState,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = file_upload, private)]
pub struct FileUpload {
    #[primary_key]
    pub id: Uuid,
    #[unique]
    pub file_id: Uuid,
    pub workspace_id: Uuid,
    #[index(btree)]
    pub owner_identity: Identity,
    pub source_key: String,
    pub completed: bool,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
    pub completed_at: Option<Timestamp>,
}

#[derive(SpacetimeType)]
pub struct FileProcessingPlanView {
    pub job_id: Uuid,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub file_id: Uuid,
    pub file_revision: u64,
    pub kind: String,
    pub source_key: String,
    pub clean_destination_key: String,
    pub cleanup_prefix: String,
    pub max_bytes: u64,
    pub max_extracted_characters: u64,
    pub allowed_types: Vec<String>,
    pub state: FileSecurityState,
    pub lease_generation: u64,
}

#[spacetimedb::table(accessor = audit_log, private)]
pub struct AuditLog {
    #[primary_key]
    pub id: Uuid,
    #[index(btree)]
    pub workspace_id: Uuid,
    pub actor_identity: Identity,
    pub effective_principal: String,
    pub action: String,
    pub resource_type: String,
    pub resource_id: Uuid,
    pub request_id: Uuid,
    pub policy_version: u32,
    pub summary: String,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = command_receipt, private)]
pub struct CommandReceipt {
    #[primary_key]
    pub key: String,
    #[index(btree)]
    pub actor_identity: Identity,
    #[index(btree)]
    pub workspace_id: Option<Uuid>,
    pub operation: String,
    pub client_request_id: Uuid,
    pub input_hash: String,
    pub result_type: String,
    pub result_id: Uuid,
    pub committed_at: Timestamp,
}
