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
pub enum OutboxState {
    Pending,
    Leased,
    Succeeded,
    Retry,
    OutcomeUnknown,
    DeadLetter,
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
    pub title: String,
    pub body: String,
    pub revision: u64,
    pub deleted: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
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

#[spacetimedb::table(accessor = agent_run, private)]
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

#[spacetimedb::table(accessor = agent_tool_call, private)]
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

#[spacetimedb::table(accessor = approval_request, private)]
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

#[spacetimedb::table(accessor = outbox_job, private)]
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
    pub expires_at: Timestamp,
    pub attempt: u32,
    pub lease_owner: Option<Identity>,
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
