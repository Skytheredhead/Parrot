use crate::model::*;
use crate::policy::{self, PolicyAction, PolicyRole};
use spacetimedb::{DbContext, Identity, ReducerContext, Uuid};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Read,
    Write,
    CreateSpace,
    ManageMembers,
    ManageWorkspace,
    ManageAgents,
    RunAgent,
    RecordDecisionOrTask,
}

pub(crate) fn workspace_member_key(workspace_id: Uuid, identity: Identity) -> String {
    format!("{workspace_id}:{identity}")
}

pub(crate) fn space_member_key(space_id: Uuid, identity: Identity) -> String {
    format!("{space_id}:{identity}")
}

pub(crate) fn agent_scope_key(
    installation_id: Uuid,
    space_id: Option<Uuid>,
    capability: AgentCapability,
) -> String {
    format!("{installation_id}:{space_id:?}:{capability:?}")
}

pub(crate) fn agent_tool_policy_key(
    installation_id: Uuid,
    tool_name: &str,
    tool_version: &str,
) -> String {
    format!(
        "{installation_id}:{}:{tool_name}:{}:{tool_version}",
        tool_name.len(),
        tool_version.len()
    )
}

pub(crate) fn trusted_tool_key(tool_name: &str, tool_version: &str) -> String {
    format!(
        "{}:{tool_name}:{}:{tool_version}",
        tool_name.len(),
        tool_version.len()
    )
}

pub(crate) fn service_grant_key(identity: Identity, workspace_id: Uuid, kind: &str) -> String {
    format!("{identity}:{workspace_id}:{}:{kind}", kind.len())
}

pub(crate) fn receipt_key(
    actor: Identity,
    workspace_id: Option<Uuid>,
    operation: &str,
    request_id: Uuid,
) -> String {
    format!(
        "{actor}:{workspace_id:?}:{}:{operation}:{request_id}",
        operation.len()
    )
}

pub(crate) fn ancestry_key(ancestor_id: Uuid, descendant_id: Uuid) -> String {
    format!("{ancestor_id}:{descendant_id}")
}

pub(crate) fn file_version_key(file_id: Uuid, content_version: u64) -> String {
    format!("{file_id}:{content_version}")
}

pub(crate) fn role_allows(role: WorkspaceRole, action: Action) -> bool {
    policy::role_allows(role.into(), action.into())
}

pub(crate) fn membership_allows(
    membership_workspace: Uuid,
    target_workspace: Uuid,
    role: WorkspaceRole,
    active: bool,
    action: Action,
) -> bool {
    policy::membership_allows(
        membership_workspace,
        target_workspace,
        role.into(),
        active,
        action.into(),
    )
}

pub(crate) fn private_space_allows(
    workspace_allowed: bool,
    visibility: SpaceVisibility,
    explicit_space_membership: bool,
) -> bool {
    policy::private_space_allows(
        workspace_allowed,
        visibility == SpaceVisibility::Private,
        explicit_space_membership,
    )
}

pub(crate) fn tool_policy_valid(effect_class: ToolEffectClass, requires_approval: bool) -> bool {
    policy::tool_policy_valid(effect_class != ToolEffectClass::Read, requires_approval)
}

fn policy_agent_state(state: AgentRunState) -> policy::PolicyAgentState {
    match state {
        AgentRunState::Queued => policy::PolicyAgentState::Queued,
        AgentRunState::Authorizing => policy::PolicyAgentState::Authorizing,
        AgentRunState::CollectingContext => policy::PolicyAgentState::CollectingContext,
        AgentRunState::Running => policy::PolicyAgentState::Running,
        AgentRunState::AwaitingApproval => policy::PolicyAgentState::AwaitingApproval,
        AgentRunState::ExecutingTool => policy::PolicyAgentState::ExecutingTool,
        AgentRunState::Succeeded => policy::PolicyAgentState::Succeeded,
        AgentRunState::Failed => policy::PolicyAgentState::Failed,
        AgentRunState::Canceled => policy::PolicyAgentState::Canceled,
        AgentRunState::Expired => policy::PolicyAgentState::Expired,
        AgentRunState::Revoked => policy::PolicyAgentState::Revoked,
    }
}

pub(crate) fn agent_event_transition_allowed(current: AgentRunState, next: AgentRunState) -> bool {
    policy::agent_event_transition_allowed(policy_agent_state(current), policy_agent_state(next))
}

pub(crate) fn task_transition_allowed(current: TaskStatus, next: TaskStatus) -> bool {
    let map = |state| match state {
        TaskStatus::Todo => policy::PolicyTaskState::Todo,
        TaskStatus::InProgress => policy::PolicyTaskState::InProgress,
        TaskStatus::Done => policy::PolicyTaskState::Done,
        TaskStatus::Canceled => policy::PolicyTaskState::Canceled,
    };
    policy::task_transition_allowed(map(current), map(next))
}

pub(crate) fn decision_transition_allowed(current: DecisionStatus, next: DecisionStatus) -> bool {
    let map = |state| match state {
        DecisionStatus::Proposed => policy::PolicyDecisionState::Proposed,
        DecisionStatus::Accepted => policy::PolicyDecisionState::Accepted,
        DecisionStatus::Rejected => policy::PolicyDecisionState::Rejected,
        DecisionStatus::Superseded => policy::PolicyDecisionState::Superseded,
    };
    policy::decision_transition_allowed(map(current), map(next))
}

pub(crate) fn derived_actor(sender: Identity, _untrusted_claimed_actor: Identity) -> Identity {
    policy::derived_actor(sender, _untrusted_claimed_actor)
}

pub(crate) fn revision_matches(actual: u64, expected: u64) -> Result<(), String> {
    policy::revision_matches(actual, expected)
}

pub(crate) fn is_duplicate_receipt(
    receipt_actor: Identity,
    sender: Identity,
    receipt_operation: &str,
    operation: &str,
    receipt_request: Uuid,
    request_id: Uuid,
) -> bool {
    policy::is_duplicate_receipt(
        receipt_actor,
        sender,
        receipt_operation,
        operation,
        receipt_request,
        request_id,
    )
}

pub(crate) type AgentGate = policy::AgentGate<Identity>;

pub(crate) fn agent_gate_allows(gate: AgentGate) -> bool {
    policy::agent_gate_allows(gate)
}

impl From<WorkspaceRole> for PolicyRole {
    fn from(value: WorkspaceRole) -> Self {
        match value {
            WorkspaceRole::Owner => Self::Owner,
            WorkspaceRole::Admin => Self::Admin,
            WorkspaceRole::Member => Self::Member,
            WorkspaceRole::Guest => Self::Guest,
        }
    }
}

impl From<Action> for PolicyAction {
    fn from(value: Action) -> Self {
        match value {
            Action::Read => Self::Read,
            Action::Write => Self::Write,
            Action::CreateSpace => Self::CreateSpace,
            Action::ManageMembers => Self::ManageMembers,
            Action::ManageWorkspace => Self::ManageWorkspace,
            Action::ManageAgents => Self::ManageAgents,
            Action::RunAgent => Self::RunAgent,
            Action::RecordDecisionOrTask => Self::RecordDecisionOrTask,
        }
    }
}

pub(crate) fn validate_text(value: &str, field: &str, max_len: usize) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    if trimmed.len() > max_len {
        return Err(format!("{field} exceeds {max_len} bytes"));
    }
    Ok(())
}

pub(crate) fn require_registered_user(ctx: &ReducerContext) -> Result<User, String> {
    crate::reducers::require_oidc(ctx)?;
    let row = ctx
        .db
        .user()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "registered user required".to_string())?;
    if row.disabled {
        return Err("user is disabled".into());
    }
    Ok(row)
}

pub(crate) fn find_membership<C: DbContext>(
    ctx: &C,
    workspace_id: Uuid,
    identity: Identity,
) -> Option<WorkspaceMember> {
    ctx.db_read_only()
        .workspace_member()
        .key()
        .find(workspace_member_key(workspace_id, identity))
}

pub(crate) fn require_workspace_action(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    action: Action,
) -> Result<WorkspaceMember, String> {
    require_registered_user(ctx)?;
    let member = find_membership(ctx, workspace_id, ctx.sender())
        .ok_or_else(|| "workspace access denied".to_string())?;
    if !membership_allows(
        member.workspace_id,
        workspace_id,
        member.role,
        member.active,
        action,
    ) {
        return Err("workspace access denied".into());
    }
    Ok(member)
}

pub(crate) fn can_read_workspace<C: DbContext>(
    ctx: &C,
    workspace_id: Uuid,
    identity: Identity,
) -> bool {
    find_membership(ctx, workspace_id, identity).is_some_and(|member| {
        membership_allows(
            member.workspace_id,
            workspace_id,
            member.role,
            member.active,
            Action::Read,
        )
    })
}

pub(crate) fn can_read_space<C: DbContext>(ctx: &C, space: &Space, identity: Identity) -> bool {
    let workspace_allowed = can_read_workspace(ctx, space.workspace_id, identity);
    let explicit = ctx
        .db_read_only()
        .space_member()
        .key()
        .find(space_member_key(space.id, identity))
        .is_some_and(|member| member.active);
    private_space_allows(workspace_allowed, space.visibility, explicit)
}

pub(crate) fn require_space_action(
    ctx: &ReducerContext,
    space_id: Uuid,
    action: Action,
) -> Result<(Space, WorkspaceMember), String> {
    let space = ctx
        .db
        .space()
        .id()
        .find(space_id)
        .ok_or_else(|| "space not found".to_string())?;
    if space.archived && action != Action::Read {
        return Err("space is archived".into());
    }
    let member = require_workspace_action(ctx, space.workspace_id, action)?;
    if space.visibility == SpaceVisibility::Private {
        let allowed = ctx
            .db
            .space_member()
            .key()
            .find(space_member_key(space.id, ctx.sender()))
            .is_some_and(|row| row.active);
        if !allowed {
            return Err("private space access denied".into());
        }
    }
    Ok((space, member))
}

pub(crate) fn require_service(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    kind: &str,
) -> Result<ServicePrincipal, String> {
    crate::reducers::require_oidc(ctx)?;
    let service = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "registered service required".to_string())?;
    if !service.enabled
        || !policy::service_runtime_scope_allows(
            service.can_run_agents,
            service.can_process_outbox,
            kind == "agent",
        )
        || !service_has_grant(ctx, ctx.sender(), workspace_id, kind)
    {
        return Err("service capability denied".into());
    }
    Ok(service)
}

pub(crate) fn service_has_grant<C: DbContext>(
    ctx: &C,
    identity: Identity,
    workspace_id: Uuid,
    kind: &str,
) -> bool {
    let grant_enabled = ctx
        .db_read_only()
        .service_grant()
        .key()
        .find(service_grant_key(identity, workspace_id, kind))
        .is_some_and(|grant| grant.enabled);
    policy::scoped_service_grant_allows(true, grant_enabled, true, true)
}
