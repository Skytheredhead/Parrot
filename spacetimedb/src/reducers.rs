use crate::authz::*;
use crate::model::*;
use spacetimedb::{Identity, ReducerContext, Table, TimeDuration, Uuid};

const POLICY_VERSION: u32 = 1;
const OUTBOX_MAX_ATTEMPTS: u32 = 12;
const OUTBOX_MAX_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_REPLY_DEPTH: u32 = 32;
const BOOTSTRAP_OIDC_ISSUER: Option<&str> =
    option_env!("PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER");
const BOOTSTRAP_OIDC_AUDIENCE: Option<&str> =
    option_env!("PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE");
const BOOTSTRAP_OWNER_SUBJECT: Option<&str> =
    option_env!("PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT");

fn normalized_input_hash(value: &str) -> String {
    blake3::hash(value.as_bytes()).to_hex().to_string()
}

fn new_id(ctx: &ReducerContext) -> Result<Uuid, String> {
    ctx.new_uuid_v7()
        .map_err(|_| "unable to allocate resource id".to_string())
}

pub(crate) fn require_oidc(ctx: &ReducerContext) -> Result<(), String> {
    let jwt = ctx
        .sender_auth()
        .jwt()
        .ok_or_else(|| "authenticated OIDC token required".to_string())?;
    let expected = ctx
        .db
        .auth_policy()
        .singleton()
        .find(0)
        .map(|policy| (policy.issuer, policy.audience))
        .or_else(|| {
            ctx.db
                .bootstrap_authority()
                .singleton()
                .find(0)
                .filter(|authority| !authority.consumed)
                .map(|authority| (authority.issuer, authority.audience))
        })
        .ok_or_else(|| "bootstrap authority has not been provisioned".to_string())?;
    if jwt.issuer() != expected.0
        || !jwt
            .audience()
            .iter()
            .any(|audience| audience == &expected.1)
    {
        return Err("token issuer or audience rejected".into());
    }
    Ok(())
}

fn verified_oidc_subject(ctx: &ReducerContext) -> Result<String, String> {
    require_oidc(ctx)?;
    ctx.sender_auth()
        .jwt()
        .map(|jwt| jwt.subject().to_owned())
        .ok_or_else(|| "authenticated OIDC token required".to_string())
}

fn require_platform_operator(ctx: &ReducerContext) -> Result<(PlatformAuthority, String), String> {
    let subject = verified_oidc_subject(ctx)?;
    let authority = ctx
        .db
        .platform_authority()
        .singleton()
        .find(0)
        .ok_or_else(|| "platform authority is not configured".to_string())?;
    if !crate::policy::platform_operator_allows(&authority.operator_subject, &subject) {
        return Err("current platform operator required".into());
    }
    Ok((authority, subject))
}

fn require_service_provision_operator(
    ctx: &ReducerContext,
    workspace_scope_valid: bool,
) -> Result<String, String> {
    let (_, subject) = require_platform_operator(ctx)?;
    if !crate::policy::service_provision_allowed(true, workspace_scope_valid) {
        return Err("platform operator and valid workspace scope required".into());
    }
    Ok(subject)
}

fn platform_receipt_key(operation: &str, request_id: Uuid) -> String {
    format!("{operation}:{request_id}")
}

fn existing_platform_receipt(
    ctx: &ReducerContext,
    operation: &str,
    request_id: Uuid,
    input_hash: &str,
    actor_subject: &str,
) -> Result<bool, String> {
    let Some(receipt) = ctx
        .db
        .platform_command_receipt()
        .key()
        .find(platform_receipt_key(operation, request_id))
    else {
        return Ok(false);
    };
    if receipt.operation != operation
        || receipt.client_request_id != request_id
        || receipt.input_hash != input_hash
        || receipt.actor_subject != actor_subject
    {
        return Err("platform idempotency replay does not match actor and input".into());
    }
    Ok(true)
}

fn insert_platform_receipt(
    ctx: &ReducerContext,
    operation: &str,
    request_id: Uuid,
    input_hash: String,
    actor_subject: String,
    committed_revision: u64,
) {
    ctx.db
        .platform_command_receipt()
        .insert(PlatformCommandReceipt {
            key: platform_receipt_key(operation, request_id),
            operation: operation.into(),
            client_request_id: request_id,
            input_hash,
            actor_subject,
            committed_revision,
            committed_at: ctx.timestamp,
        });
}

struct PlatformAuditInput<'a> {
    actor_subject: &'a str,
    workspace_id: Option<Uuid>,
    action: &'a str,
    resource: String,
    request_id: Uuid,
    summary: &'a str,
}

fn platform_audit(ctx: &ReducerContext, input: PlatformAuditInput<'_>) -> Result<(), String> {
    ctx.db.platform_audit_log().insert(PlatformAuditLog {
        id: new_id(ctx)?,
        actor_identity: ctx.sender(),
        actor_subject: input.actor_subject.into(),
        workspace_id: input.workspace_id,
        action: input.action.into(),
        resource: input.resource,
        request_id: input.request_id,
        summary: input.summary.into(),
        created_at: ctx.timestamp,
    });
    Ok(())
}

fn compiled_bootstrap_configuration() -> Result<(&'static str, &'static str, &'static str), String>
{
    let issuer = BOOTSTRAP_OIDC_ISSUER.ok_or_else(|| {
        "module build is missing PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER".to_string()
    })?;
    let audience = BOOTSTRAP_OIDC_AUDIENCE.ok_or_else(|| {
        "module build is missing PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE".to_string()
    })?;
    let owner_subject = BOOTSTRAP_OWNER_SUBJECT.ok_or_else(|| {
        "module build is missing PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT".to_string()
    })?;
    if !crate::policy::bootstrap_configuration_valid(
        Some(issuer),
        Some(audience),
        Some(owner_subject),
    ) {
        return Err("compiled bootstrap authority is invalid".into());
    }
    Ok((issuer, audience, owner_subject))
}

fn has_application_state(ctx: &ReducerContext) -> bool {
    ctx.db.pending_operator_transfer().count() != 0
        || ctx.db.platform_command_receipt().count() != 0
        || ctx.db.platform_audit_log().count() != 0
        || ctx.db.user().count() != 0
        || ctx.db.workspace().count() != 0
        || ctx.db.workspace_member().count() != 0
        || ctx.db.space().count() != 0
        || ctx.db.space_member().count() != 0
        || ctx.db.post().count() != 0
        || ctx.db.named_thread().count() != 0
        || ctx.db.contribution().count() != 0
        || ctx.db.reply_ancestry().count() != 0
        || ctx.db.decision_record().count() != 0
        || ctx.db.task_item().count() != 0
        || ctx.db.notification().count() != 0
        || ctx.db.service_principal().count() != 0
        || ctx.db.service_grant().count() != 0
        || ctx.db.agent_installation().count() != 0
        || ctx.db.agent_scope().count() != 0
        || ctx.db.agent_tool_policy().count() != 0
        || ctx.db.trusted_tool().count() != 0
        || ctx.db.agent_run().count() != 0
        || ctx.db.agent_run_event().count() != 0
        || ctx.db.agent_context_manifest().count() != 0
        || ctx.db.agent_tool_call().count() != 0
        || ctx.db.approval_request().count() != 0
        || ctx.db.effect_ledger().count() != 0
        || ctx.db.outbox_job().count() != 0
        || ctx.db.search_document_snapshot().count() != 0
        || ctx.db.file_record().count() != 0
        || ctx.db.file_version().count() != 0
        || ctx.db.file_upload().count() != 0
        || ctx.db.audit_log().count() != 0
        || ctx.db.command_receipt().count() != 0
}

fn existing_receipt(
    ctx: &ReducerContext,
    workspace_id: Option<Uuid>,
    operation: &str,
    request_id: Uuid,
    input_hash: &str,
) -> Result<Option<CommandReceipt>, String> {
    let key = receipt_key(ctx.sender(), workspace_id, operation, request_id);
    let existing = ctx.db.command_receipt().key().find(key);
    if let Some(row) = &existing
        && (!is_duplicate_receipt(
            row.actor_identity,
            ctx.sender(),
            &row.operation,
            operation,
            row.client_request_id,
            request_id,
        ) || !crate::policy::command_replay_matches(
            row.workspace_id == workspace_id,
            row.input_hash == input_hash,
        ))
    {
        return Err("idempotency replay does not match workspace and input".into());
    }
    Ok(existing)
}

fn insert_receipt(
    ctx: &ReducerContext,
    workspace_id: Option<Uuid>,
    operation: &str,
    request_id: Uuid,
    input_hash: String,
    result_type: &str,
    result_id: Uuid,
) {
    ctx.db.command_receipt().insert(CommandReceipt {
        key: receipt_key(ctx.sender(), workspace_id, operation, request_id),
        actor_identity: derived_actor(ctx.sender(), ctx.sender()),
        workspace_id,
        operation: operation.into(),
        client_request_id: request_id,
        input_hash,
        result_type: result_type.into(),
        result_id,
        committed_at: ctx.timestamp,
    });
}

struct AuditInput<'a> {
    workspace_id: Uuid,
    action: &'a str,
    resource_type: &'a str,
    resource_id: Uuid,
    request_id: Uuid,
    effective_principal: &'a str,
    summary: &'a str,
}

fn audit(ctx: &ReducerContext, input: AuditInput<'_>) -> Result<(), String> {
    ctx.db.audit_log().insert(AuditLog {
        id: new_id(ctx)?,
        workspace_id: input.workspace_id,
        actor_identity: ctx.sender(),
        effective_principal: input.effective_principal.into(),
        action: input.action.into(),
        resource_type: input.resource_type.into(),
        resource_id: input.resource_id,
        request_id: input.request_id,
        policy_version: POLICY_VERSION,
        summary: input.summary.into(),
        created_at: ctx.timestamp,
    });
    Ok(())
}

fn enqueue_outbox(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    kind: &str,
    resource_type: &str,
    resource_id: Uuid,
    resource_revision: u64,
    effect_key: String,
) -> Result<(), String> {
    ctx.db.outbox_job().insert(OutboxJob {
        id: new_id(ctx)?,
        workspace_id,
        effect_key: effect_key.clone(),
        state: OutboxState::Pending,
        kind: kind.into(),
        resource_type: resource_type.into(),
        resource_id,
        resource_revision,
        expires_at: ctx.timestamp + TimeDuration::from_micros(OUTBOX_MAX_AGE_SECONDS * 1_000_000),
        attempt: 0,
        lease_owner: None,
        lease_until: None,
        lease_generation: 0,
        next_attempt_at: ctx.timestamp,
        last_error: String::new(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

fn search_allowed_identities(ctx: &ReducerContext, space: &Space) -> Vec<Identity> {
    match space.visibility {
        SpaceVisibility::Workspace => ctx
            .db
            .workspace_member()
            .workspace_id()
            .filter(space.workspace_id)
            .filter(|member| member.active)
            .map(|member| member.identity)
            .collect(),
        SpaceVisibility::Private => ctx
            .db
            .space_member()
            .space_id()
            .filter(space.id)
            .filter(|member| member.active)
            .filter(|member| {
                find_membership(ctx, space.workspace_id, member.identity)
                    .is_some_and(|workspace_member| workspace_member.active)
            })
            .map(|member| member.identity)
            .collect(),
    }
}

struct SearchSnapshotInput<'a> {
    workspace_id: Uuid,
    space_id: Uuid,
    resource_type: &'a str,
    resource_id: Uuid,
    resource_revision: u64,
    title: &'a str,
    body: &'a str,
    tombstone: bool,
}

fn enqueue_search_snapshot(
    ctx: &ReducerContext,
    input: SearchSnapshotInput<'_>,
) -> Result<(), String> {
    let space = ctx
        .db
        .space()
        .id()
        .find(input.space_id)
        .ok_or_else(|| "search snapshot space not found".to_string())?;
    if space.workspace_id != input.workspace_id {
        return Err("search snapshot workspace mismatch".into());
    }
    let effect_key = format!(
        "search:{}:{}:revision:{}:acl:{}:{}",
        input.resource_type,
        input.resource_id,
        input.resource_revision,
        space.revision,
        if input.tombstone { "delete" } else { "upsert" },
    );
    ctx.db
        .search_document_snapshot()
        .insert(SearchDocumentSnapshot {
            effect_key: effect_key.clone(),
            workspace_id: input.workspace_id,
            space_id: input.space_id,
            resource_type: input.resource_type.into(),
            resource_id: input.resource_id,
            resource_revision: input.resource_revision,
            acl_revision: space.revision,
            title: input.title.into(),
            body: input.body.into(),
            tombstone: input.tombstone,
            allowed_identities: search_allowed_identities(ctx, &space),
            created_at: ctx.timestamp,
        });
    enqueue_outbox(
        ctx,
        input.workspace_id,
        if input.tombstone {
            "search_tombstone"
        } else {
            "search_upsert"
        },
        input.resource_type,
        input.resource_id,
        input.resource_revision,
        effect_key,
    )
}

fn refresh_space_search_acl(ctx: &ReducerContext, space_id: Uuid) -> Result<(), String> {
    let mut space = ctx
        .db
        .space()
        .id()
        .find(space_id)
        .ok_or_else(|| "space not found".to_string())?;
    space.revision = space.revision.saturating_add(1);
    space.updated_at = ctx.timestamp;
    ctx.db.space().id().update(space.clone());
    for post in ctx.db.post().space_id().filter(space_id) {
        enqueue_search_snapshot(
            ctx,
            SearchSnapshotInput {
                workspace_id: post.workspace_id,
                space_id,
                resource_type: "post",
                resource_id: post.id,
                resource_revision: post.revision,
                title: &post.title,
                body: &post.body,
                tombstone: post.deleted,
            },
        )?;
    }
    for thread in ctx.db.named_thread().space_id().filter(space_id) {
        for contribution in ctx.db.contribution().thread_id().filter(thread.id) {
            enqueue_search_snapshot(
                ctx,
                SearchSnapshotInput {
                    workspace_id: contribution.workspace_id,
                    space_id,
                    resource_type: "contribution",
                    resource_id: contribution.id,
                    resource_revision: contribution.revision,
                    title: &thread.title,
                    body: &contribution.body,
                    tombstone: contribution.deleted,
                },
            )?;
        }
    }
    Ok(())
}

fn is_terminal(state: AgentRunState) -> bool {
    matches!(
        state,
        AgentRunState::Succeeded
            | AgentRunState::Failed
            | AgentRunState::Canceled
            | AgentRunState::Expired
            | AgentRunState::Revoked
    )
}

fn cancel_open_agent_work(ctx: &ReducerContext, run_id: Uuid) {
    for mut approval in ctx.db.approval_request().run_id().filter(run_id) {
        if matches!(
            approval.state,
            ApprovalState::Pending | ApprovalState::Approved
        ) {
            approval.state = ApprovalState::Rejected;
            approval.decided_at = Some(ctx.timestamp);
            ctx.db.approval_request().id().update(approval);
        }
    }
    for mut tool in ctx.db.agent_tool_call().run_id().filter(run_id) {
        if matches!(
            tool.state,
            ToolCallState::Proposed | ToolCallState::AwaitingApproval | ToolCallState::Approved
        ) {
            tool.state = ToolCallState::Canceled;
            tool.updated_at = ctx.timestamp;
            ctx.db.agent_tool_call().id().update(tool);
        } else if tool.state == ToolCallState::Executing {
            tool.state = ToolCallState::OutcomeUnknown;
            tool.updated_at = ctx.timestamp;
            if let Some(mut ledger) = ctx
                .db
                .effect_ledger()
                .effect_key()
                .find(tool.effect_key.clone())
            {
                ledger.state = EffectLedgerState::OutcomeUnknown;
                ledger.updated_at = ctx.timestamp;
                ctx.db.effect_ledger().effect_key().update(ledger);
            }
            ctx.db.agent_tool_call().id().update(tool);
        }
    }
}

fn agent_scope_enabled(
    ctx: &ReducerContext,
    installation_id: Uuid,
    space_id: Uuid,
    capability: AgentCapability,
) -> bool {
    [Some(space_id), None].into_iter().any(|scope_space| {
        ctx.db
            .agent_scope()
            .key()
            .find(agent_scope_key(installation_id, scope_space, capability))
            .is_some_and(|scope| scope.enabled)
    })
}

fn tool_execution_policy_current(
    ctx: &ReducerContext,
    run: &AgentRun,
    tool: &AgentToolCall,
) -> bool {
    let Some(policy) = ctx
        .db
        .agent_tool_policy()
        .key()
        .find(tool.policy_key.clone())
    else {
        return false;
    };
    let Some(trusted) = ctx
        .db
        .trusted_tool()
        .key()
        .find(trusted_tool_key(&tool.tool_name, &tool.tool_version))
    else {
        return false;
    };
    crate::policy::trusted_tool_execution_current(crate::policy::TrustedToolExecutionState {
        policy_enabled: policy.enabled,
        policy_revision: policy.revision,
        pinned_policy_revision: tool.policy_revision,
        catalog_enabled: trusted.enabled,
        catalog_revision: trusted.revision,
        pinned_catalog_revision: policy.trusted_tool_revision,
        installation_matches: policy.installation_id == run.installation_id,
        tool_identity_matches: policy.tool_name == tool.tool_name
            && policy.tool_version == tool.tool_version
            && trusted.tool_name == tool.tool_name
            && trusted.tool_version == tool.tool_version
            && tool.policy_key
                == agent_tool_policy_key(run.installation_id, &tool.tool_name, &tool.tool_version),
        capability_matches: policy.capability == trusted.capability,
        effect_class_matches: policy.effect_class == trusted.effect_class
            && tool.effect_class == policy.effect_class,
        approval_requirement_matches: tool.requires_approval == policy.requires_approval,
    }) && agent_scope_enabled(ctx, run.installation_id, run.space_id, policy.capability)
}

fn fence_stale_tool_execution(
    ctx: &ReducerContext,
    mut run: AgentRun,
    mut tool: AgentToolCall,
    mut ledger: EffectLedger,
    effect_may_have_occurred: bool,
) {
    cancel_open_agent_work(ctx, run.id);
    let summary = if effect_may_have_occurred {
        tool.state = ToolCallState::OutcomeUnknown;
        ledger.state = EffectLedgerState::OutcomeUnknown;
        "tool authorization changed after effect acquisition; outcome requires operator reconciliation"
    } else {
        tool.state = ToolCallState::Canceled;
        ledger.state = EffectLedgerState::Failed;
        ledger.owner_identity = None;
        ledger.owner_generation = 0;
        "tool authorization revoked before effect acquisition"
    };
    tool.result_summary = summary.into();
    tool.updated_at = ctx.timestamp;
    ledger.result_summary = summary.into();
    ledger.updated_at = ctx.timestamp;
    run.state = AgentRunState::Revoked;
    run.cancel_requested = true;
    run.lease_owner = None;
    run.lease_until = None;
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_tool_call().id().update(tool);
    ctx.db.effect_ledger().effect_key().update(ledger);
    ctx.db.agent_run().id().update(run);
}

fn fence_tool_calls_for_catalog_change(ctx: &ReducerContext, tool_name: &str, tool_version: &str) {
    let affected_ids: Vec<_> = ctx
        .db
        .agent_tool_call()
        .iter()
        .filter(|tool| tool.tool_name == tool_name && tool.tool_version == tool_version)
        .filter(|tool| {
            matches!(
                tool.state,
                ToolCallState::Proposed
                    | ToolCallState::AwaitingApproval
                    | ToolCallState::Approved
                    | ToolCallState::Executing
                    | ToolCallState::OutcomeUnknown
            )
        })
        .map(|tool| tool.id)
        .collect();
    for tool_id in affected_ids {
        let Some(tool) = ctx.db.agent_tool_call().id().find(tool_id) else {
            continue;
        };
        if !matches!(
            tool.state,
            ToolCallState::Proposed
                | ToolCallState::AwaitingApproval
                | ToolCallState::Approved
                | ToolCallState::Executing
                | ToolCallState::OutcomeUnknown
        ) {
            continue;
        }
        let Some(run) = ctx.db.agent_run().id().find(tool.run_id) else {
            continue;
        };
        let Some(ledger) = ctx
            .db
            .effect_ledger()
            .effect_key()
            .find(tool.effect_key.clone())
        else {
            continue;
        };
        let effect_may_have_occurred = matches!(
            ledger.state,
            EffectLedgerState::Acquired | EffectLedgerState::OutcomeUnknown
        ) || matches!(
            tool.state,
            ToolCallState::Executing | ToolCallState::OutcomeUnknown
        );
        fence_stale_tool_execution(ctx, run, tool, ledger, effect_may_have_occurred);
    }
}

fn validate_agent_lease(
    ctx: &ReducerContext,
    run: &AgentRun,
    lease_generation: u64,
    approval_required: bool,
    approval_valid: bool,
) -> Result<AgentInstallation, String> {
    let installation = ctx
        .db
        .agent_installation()
        .id()
        .find(run.installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    let membership = find_membership(ctx, run.workspace_id, run.initiated_by)
        .ok_or_else(|| "initiating membership revoked".to_string())?;
    let owner = run
        .lease_owner
        .ok_or_else(|| "agent run has no worker lease".to_string())?;
    let gate = AgentGate {
        installation_enabled: installation.enabled,
        captured_installation_epoch: run.installation_epoch,
        current_installation_epoch: installation.authz_epoch,
        captured_membership_epoch: run.membership_epoch,
        current_membership_epoch: membership.authz_epoch,
        cancel_requested: run.cancel_requested,
        expected_lease_owner: owner,
        caller: ctx.sender(),
        expected_lease_generation: run.lease_generation,
        supplied_lease_generation: lease_generation,
        approval_required,
        approval_valid,
    };
    if !membership.active || !agent_gate_allows(gate) {
        return Err("agent authorization, lease, or approval is stale".into());
    }
    if run.lease_until.is_none_or(|expiry| expiry <= ctx.timestamp) {
        return Err("agent worker lease expired".into());
    }
    Ok(installation)
}

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) -> Result<(), String> {
    require_oidc(ctx)
}

#[spacetimedb::reducer(init)]
pub fn initialize_bootstrap_authority(ctx: &ReducerContext) -> Result<(), String> {
    let (issuer, audience, owner_subject) = compiled_bootstrap_configuration()
        .map_err(|error| format!("{error}; refusing initialization"))?;
    if ctx.db.auth_policy().count() != 0 || ctx.db.bootstrap_authority().count() != 0 {
        return Err("bootstrap authority tables must be empty during initialization".into());
    }
    ctx.db.bootstrap_authority().insert(BootstrapAuthority {
        singleton: 0,
        issuer: issuer.into(),
        audience: audience.into(),
        owner_subject: owner_subject.into(),
        consumed: false,
        configured_at: ctx.timestamp,
    });
    Ok(())
}

#[spacetimedb::reducer(update)]
pub fn migrate_platform_authority(ctx: &ReducerContext) -> Result<(), String> {
    let policy = ctx.db.auth_policy().singleton().find(0);
    let bootstrap = ctx.db.bootstrap_authority().singleton().find(0);
    let platform = ctx.db.platform_authority().singleton().find(0);
    let pending_operator = ctx.db.pending_operator_transfer().singleton().find(0);
    if ctx.db.auth_policy().count() != u64::from(policy.is_some())
        || ctx.db.bootstrap_authority().count() != u64::from(bootstrap.is_some())
        || ctx.db.platform_authority().count() != u64::from(platform.is_some())
        || ctx.db.pending_operator_transfer().count() != u64::from(pending_operator.is_some())
    {
        return Err("authority singleton table contains an unexpected key; refusing update".into());
    }
    if let Some(pending) = pending_operator.as_ref() {
        let current = platform
            .as_ref()
            .ok_or_else(|| "operator transfer exists without platform authority".to_string())?;
        if pending.authority_revision != current.revision
            || !crate::policy::oidc_subject_valid(&pending.proposed_subject)
            || pending.proposed_subject == current.operator_subject
        {
            return Err("pending operator transfer is inconsistent; refusing update".into());
        }
    }
    if let Some((policy, bootstrap)) = policy.as_ref().zip(bootstrap.as_ref())
        && !crate::policy::bootstrap_configuration_valid(
            Some(&policy.issuer),
            Some(&policy.audience),
            Some(&bootstrap.owner_subject),
        )
    {
        return Err("existing immutable authentication policy is invalid; refusing update".into());
    }
    let policy_matches_bootstrap =
        policy
            .as_ref()
            .zip(bootstrap.as_ref())
            .is_some_and(|(policy, bootstrap)| {
                policy.issuer == bootstrap.issuer && policy.audience == bootstrap.audience
            });
    let action = crate::policy::classify_platform_update(crate::policy::PlatformUpdateState {
        has_platform_authority: platform.is_some(),
        has_auth_policy: policy.is_some(),
        has_bootstrap_authority: bootstrap.is_some(),
        bootstrap_consumed: bootstrap.as_ref().is_some_and(|row| row.consumed),
        policy_matches_bootstrap,
        has_application_state: has_application_state(ctx),
    })
    .map_err(|error| format!("unsafe platform authority migration refused: {error}"))?;

    match action {
        crate::policy::PlatformUpdateAction::ProvisionBootstrap => {
            let (issuer, audience, owner_subject) = compiled_bootstrap_configuration()
                .map_err(|error| format!("{error}; refusing empty-database migration"))?;
            ctx.db.bootstrap_authority().insert(BootstrapAuthority {
                singleton: 0,
                issuer: issuer.into(),
                audience: audience.into(),
                owner_subject: owner_subject.into(),
                consumed: false,
                configured_at: ctx.timestamp,
            });
        }
        crate::policy::PlatformUpdateAction::BackfillPlatformAuthority => {
            let policy =
                policy.ok_or_else(|| "auth policy disappeared during update".to_string())?;
            let bootstrap = bootstrap
                .ok_or_else(|| "bootstrap authority disappeared during update".to_string())?;
            if !crate::policy::oidc_subject_valid(&bootstrap.owner_subject) {
                return Err("legacy bootstrap owner subject is invalid; refusing backfill".into());
            }
            ctx.db.platform_authority().insert(PlatformAuthority {
                singleton: 0,
                operator_subject: bootstrap.owner_subject,
                revision: 1,
                updated_by: policy.configured_by,
                configured_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });
        }
        crate::policy::PlatformUpdateAction::Noop => {
            if let Some(platform) = platform {
                if platform.revision == 0
                    || !crate::policy::oidc_subject_valid(&platform.operator_subject)
                {
                    return Err("existing platform authority is invalid; refusing update".into());
                }
            } else {
                let bootstrap = bootstrap.ok_or_else(|| {
                    "pre-bootstrap authority disappeared during update".to_string()
                })?;
                let (issuer, audience, owner_subject) = compiled_bootstrap_configuration()
                    .map_err(|error| format!("{error}; refusing pre-bootstrap migration"))?;
                if bootstrap.issuer != issuer
                    || bootstrap.audience != audience
                    || bootstrap.owner_subject != owner_subject
                {
                    return Err(
                        "compiled authority changed while bootstrap is pending; refusing update"
                            .into(),
                    );
                }
            }
        }
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn bootstrap_owner(
    ctx: &ReducerContext,
    display_name: String,
    workspace_name: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    require_oidc(ctx)?;
    validate_text(&display_name, "display name", 120)?;
    validate_text(&workspace_name, "workspace name", 120)?;
    let input_hash = normalized_input_hash(&format!("{display_name}\0{workspace_name}"));
    if existing_receipt(ctx, None, "bootstrap_owner", client_request_id, &input_hash)?.is_some() {
        return Ok(());
    }
    if ctx.db.user().count() != 0
        || ctx.db.workspace().count() != 0
        || ctx.db.auth_policy().count() != 0
        || ctx.db.platform_authority().count() != 0
    {
        return Err("bootstrap is already complete".into());
    }
    let mut authority = ctx
        .db
        .bootstrap_authority()
        .singleton()
        .find(0)
        .filter(|authority| !authority.consumed)
        .ok_or_else(|| "bootstrap authority is not available".to_string())?;
    let subject = ctx
        .sender_auth()
        .jwt()
        .map(|jwt| jwt.subject().to_owned())
        .ok_or_else(|| "authenticated OIDC token required".to_string())?;
    if !crate::policy::bootstrap_subject_allowed(&authority.owner_subject, &subject) {
        return Err("OIDC subject is not authorized to bootstrap this deployment".into());
    }
    let workspace_id = new_id(ctx)?;
    ctx.db.auth_policy().insert(AuthPolicy {
        singleton: 0,
        issuer: authority.issuer.clone(),
        audience: authority.audience.clone(),
        configured_by: ctx.sender(),
        configured_at: ctx.timestamp,
    });
    ctx.db.platform_authority().insert(PlatformAuthority {
        singleton: 0,
        operator_subject: subject,
        revision: 1,
        updated_by: ctx.sender(),
        configured_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    authority.consumed = true;
    ctx.db.bootstrap_authority().singleton().update(authority);
    ctx.db.user().insert(User {
        identity: ctx.sender(),
        display_name: display_name.trim().into(),
        disabled: false,
        authz_epoch: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.workspace().insert(Workspace {
        id: workspace_id,
        name: workspace_name.trim().into(),
        owner_identity: ctx.sender(),
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.workspace_member().insert(WorkspaceMember {
        key: workspace_member_key(workspace_id, ctx.sender()),
        workspace_id,
        identity: ctx.sender(),
        role: WorkspaceRole::Owner,
        active: true,
        authz_epoch: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    insert_receipt(
        ctx,
        None,
        "bootstrap_owner",
        client_request_id,
        input_hash,
        "workspace",
        workspace_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "bootstrap_owner",
            resource_type: "workspace",
            resource_id: workspace_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "initial owner and OIDC policy configured",
        },
    )
}

fn validate_authority_change_ttl(ttl_seconds: u32) -> Result<(), String> {
    if !(60..=86_400).contains(&ttl_seconds) {
        return Err("authority change TTL must be between 60 and 86400 seconds".into());
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn propose_platform_operator_transfer(
    ctx: &ReducerContext,
    new_operator_subject: String,
    expected_revision: u64,
    ttl_seconds: u32,
    client_request_id: Uuid,
) -> Result<(), String> {
    let caller_subject = verified_oidc_subject(ctx)?;
    let input_hash = normalized_input_hash(&format!(
        "{new_operator_subject}\0{expected_revision}\0{ttl_seconds}"
    ));
    if existing_platform_receipt(
        ctx,
        "propose_platform_operator_transfer",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let (authority, operator_subject) = require_platform_operator(ctx)?;
    validate_authority_change_ttl(ttl_seconds)?;
    if !crate::policy::oidc_subject_valid(&new_operator_subject) {
        return Err("new platform operator subject is invalid".into());
    }
    if !crate::policy::platform_change_allowed(true, authority.revision, expected_revision) {
        return Err("platform operator or revision is stale".into());
    }
    if authority.operator_subject == new_operator_subject {
        return Err("new platform operator subject must differ from the current subject".into());
    }
    let pending = PendingOperatorTransfer {
        singleton: 0,
        proposed_subject: new_operator_subject,
        authority_revision: authority.revision,
        proposed_by: ctx.sender(),
        proposed_at: ctx.timestamp,
        expires_at: ctx.timestamp + TimeDuration::from_micros(i64::from(ttl_seconds) * 1_000_000),
    };
    if let Some(existing) = ctx.db.pending_operator_transfer().singleton().find(0) {
        if existing.expires_at > ctx.timestamp {
            return Err("an unexpired platform operator transfer is already pending".into());
        }
        ctx.db
            .pending_operator_transfer()
            .singleton()
            .update(pending);
    } else {
        ctx.db.pending_operator_transfer().insert(pending);
    }
    insert_platform_receipt(
        ctx,
        "propose_platform_operator_transfer",
        client_request_id,
        input_hash,
        operator_subject.clone(),
        authority.revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &operator_subject,
            workspace_id: None,
            action: "propose_platform_operator_transfer",
            resource: "platform_authority".into(),
            request_id: client_request_id,
            summary: "platform operator transfer proposed",
        },
    )
}

#[spacetimedb::reducer]
pub fn accept_platform_operator_transfer(
    ctx: &ReducerContext,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let caller_subject = verified_oidc_subject(ctx)?;
    let input_hash = normalized_input_hash(&expected_revision.to_string());
    if existing_platform_receipt(
        ctx,
        "accept_platform_operator_transfer",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let pending = ctx
        .db
        .pending_operator_transfer()
        .singleton()
        .find(0)
        .filter(|pending| pending.expires_at > ctx.timestamp)
        .ok_or_else(|| "operator transfer is unavailable or expired".to_string())?;
    if pending.proposed_subject != caller_subject {
        return Err("proposed operator recipient token required".into());
    }
    let mut authority = ctx
        .db
        .platform_authority()
        .singleton()
        .find(0)
        .ok_or_else(|| "platform authority is not configured".to_string())?;
    if authority.revision != expected_revision || pending.authority_revision != expected_revision {
        return Err("operator transfer authority revision is stale".into());
    }
    authority.operator_subject = caller_subject.clone();
    authority.revision = authority.revision.saturating_add(1);
    authority.updated_by = ctx.sender();
    authority.updated_at = ctx.timestamp;
    let committed_revision = authority.revision;
    ctx.db.platform_authority().singleton().update(authority);
    ctx.db.pending_operator_transfer().singleton().delete(0);
    insert_platform_receipt(
        ctx,
        "accept_platform_operator_transfer",
        client_request_id,
        input_hash,
        caller_subject.clone(),
        committed_revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &caller_subject,
            workspace_id: None,
            action: "accept_platform_operator_transfer",
            resource: "platform_authority".into(),
            request_id: client_request_id,
            summary: "platform operator transfer accepted by recipient",
        },
    )
}

#[spacetimedb::reducer]
pub fn cancel_platform_operator_transfer(
    ctx: &ReducerContext,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let (authority, operator_subject) = require_platform_operator(ctx)?;
    let input_hash = normalized_input_hash(&expected_revision.to_string());
    if existing_platform_receipt(
        ctx,
        "cancel_platform_operator_transfer",
        client_request_id,
        &input_hash,
        &operator_subject,
    )? {
        return Ok(());
    }
    let pending = ctx
        .db
        .pending_operator_transfer()
        .singleton()
        .find(0)
        .ok_or_else(|| "no platform operator transfer is pending".to_string())?;
    if authority.revision != expected_revision || pending.authority_revision != expected_revision {
        return Err("operator transfer authority revision is stale".into());
    }
    ctx.db.pending_operator_transfer().singleton().delete(0);
    insert_platform_receipt(
        ctx,
        "cancel_platform_operator_transfer",
        client_request_id,
        input_hash,
        operator_subject.clone(),
        authority.revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &operator_subject,
            workspace_id: None,
            action: "cancel_platform_operator_transfer",
            resource: "platform_authority".into(),
            request_id: client_request_id,
            summary: "platform operator transfer canceled",
        },
    )
}

#[spacetimedb::reducer]
pub fn expire_platform_operator_transfer(
    ctx: &ReducerContext,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let caller_subject = verified_oidc_subject(ctx)?;
    let input_hash = normalized_input_hash(&expected_revision.to_string());
    if existing_platform_receipt(
        ctx,
        "expire_platform_operator_transfer",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let pending = ctx
        .db
        .pending_operator_transfer()
        .singleton()
        .find(0)
        .filter(|pending| pending.expires_at <= ctx.timestamp)
        .ok_or_else(|| "operator transfer has not expired".to_string())?;
    let authority = ctx
        .db
        .platform_authority()
        .singleton()
        .find(0)
        .ok_or_else(|| "platform authority is not configured".to_string())?;
    if authority.revision != expected_revision || pending.authority_revision != expected_revision {
        return Err("operator transfer authority revision is stale".into());
    }
    ctx.db.pending_operator_transfer().singleton().delete(0);
    insert_platform_receipt(
        ctx,
        "expire_platform_operator_transfer",
        client_request_id,
        input_hash,
        caller_subject.clone(),
        authority.revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &caller_subject,
            workspace_id: None,
            action: "expire_platform_operator_transfer",
            resource: "platform_authority".into(),
            request_id: client_request_id,
            summary: "expired platform operator transfer cleared",
        },
    )
}

#[spacetimedb::reducer]
pub fn register_user(ctx: &ReducerContext, display_name: String) -> Result<(), String> {
    require_oidc(ctx)?;
    validate_text(&display_name, "display name", 120)?;
    if let Some(mut row) = ctx.db.user().identity().find(ctx.sender()) {
        if row.disabled {
            return Err("user is disabled".into());
        }
        row.display_name = display_name.trim().into();
        row.updated_at = ctx.timestamp;
        ctx.db.user().identity().update(row);
        return Ok(());
    }
    if ctx.db.auth_policy().singleton().find(0).is_none() {
        return Err("system bootstrap required".into());
    }
    ctx.db.user().insert(User {
        identity: ctx.sender(),
        display_name: display_name.trim().into(),
        disabled: false,
        authz_epoch: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn create_workspace(
    ctx: &ReducerContext,
    name: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    require_registered_user(ctx)?;
    validate_text(&name, "workspace name", 120)?;
    let input_hash = normalized_input_hash(name.trim());
    if existing_receipt(
        ctx,
        None,
        "create_workspace",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.workspace().insert(Workspace {
        id,
        name: name.trim().into(),
        owner_identity: ctx.sender(),
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.workspace_member().insert(WorkspaceMember {
        key: workspace_member_key(id, ctx.sender()),
        workspace_id: id,
        identity: ctx.sender(),
        role: WorkspaceRole::Owner,
        active: true,
        authz_epoch: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    insert_receipt(
        ctx,
        None,
        "create_workspace",
        client_request_id,
        input_hash,
        "workspace",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: id,
            action: "create_workspace",
            resource_type: "workspace",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "workspace created",
        },
    )
}

#[spacetimedb::reducer]
pub fn set_workspace_member(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    identity: Identity,
    role: WorkspaceRole,
    active: bool,
    expected_authz_epoch: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    require_workspace_action(ctx, workspace_id, Action::ManageMembers)?;
    if role == WorkspaceRole::Owner {
        return Err("ownership transfer requires a dedicated reducer".into());
    }
    let target_user = ctx
        .db
        .user()
        .identity()
        .find(identity)
        .ok_or_else(|| "target user not registered".to_string())?;
    if target_user.disabled {
        return Err("target user is disabled".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{workspace_id}\0{identity}\0{role:?}\0{active}\0{expected_authz_epoch}"
    ));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "set_workspace_member",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let key = workspace_member_key(workspace_id, identity);
    let next_epoch;
    if let Some(mut row) = ctx.db.workspace_member().key().find(key.clone()) {
        if row.role == WorkspaceRole::Owner {
            return Err("owner membership cannot be changed here".into());
        }
        revision_matches(row.authz_epoch, expected_authz_epoch)?;
        row.role = role;
        row.active = active;
        row.authz_epoch = row.authz_epoch.saturating_add(1);
        row.updated_at = ctx.timestamp;
        next_epoch = row.authz_epoch;
        ctx.db.workspace_member().key().update(row);
    } else {
        if expected_authz_epoch != 0 {
            return Err("new membership must use expected epoch 0".into());
        }
        next_epoch = 1;
        ctx.db.workspace_member().insert(WorkspaceMember {
            key,
            workspace_id,
            identity,
            role,
            active,
            authz_epoch: next_epoch,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    }
    let workspace_spaces: Vec<_> = ctx.db.space().workspace_id().filter(workspace_id).collect();
    for space in workspace_spaces {
        refresh_space_search_acl(ctx, space.id)?;
    }
    for mut run in ctx.db.agent_run().workspace_id().filter(workspace_id) {
        if run.initiated_by == identity && !is_terminal(run.state) {
            cancel_open_agent_work(ctx, run.id);
            run.cancel_requested = true;
            run.state = AgentRunState::Revoked;
            run.lease_owner = None;
            run.lease_until = None;
            run.version = run.version.saturating_add(1);
            run.updated_at = ctx.timestamp;
            ctx.db.agent_run().id().update(run);
        }
    }
    insert_receipt(
        ctx,
        Some(workspace_id),
        "set_workspace_member",
        client_request_id,
        input_hash,
        "workspace_member",
        workspace_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "set_workspace_member",
            resource_type: "workspace_member",
            resource_id: workspace_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: &format!("membership epoch advanced to {next_epoch}"),
        },
    )
}

#[spacetimedb::reducer]
pub fn create_space(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    name: String,
    visibility: SpaceVisibility,
    client_request_id: Uuid,
) -> Result<(), String> {
    require_workspace_action(ctx, workspace_id, Action::CreateSpace)?;
    validate_text(&name, "space name", 120)?;
    let input_hash =
        normalized_input_hash(&format!("{workspace_id}\0{}\0{visibility:?}", name.trim()));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "create_space",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.space().insert(Space {
        id,
        workspace_id,
        name: name.trim().into(),
        visibility,
        archived: false,
        revision: 1,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    if visibility == SpaceVisibility::Private {
        ctx.db.space_member().insert(SpaceMember {
            key: space_member_key(id, ctx.sender()),
            space_id: id,
            identity: ctx.sender(),
            active: true,
            authz_epoch: 1,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    }
    insert_receipt(
        ctx,
        Some(workspace_id),
        "create_space",
        client_request_id,
        input_hash,
        "space",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "create_space",
            resource_type: "space",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "space created",
        },
    )
}

#[spacetimedb::reducer]
pub fn set_space_member(
    ctx: &ReducerContext,
    space_id: Uuid,
    identity: Identity,
    active: bool,
    expected_authz_epoch: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let space = ctx
        .db
        .space()
        .id()
        .find(space_id)
        .ok_or_else(|| "space not found".to_string())?;
    require_workspace_action(ctx, space.workspace_id, Action::ManageMembers)?;
    let target = find_membership(ctx, space.workspace_id, identity)
        .ok_or_else(|| "target is not a workspace member".to_string())?;
    if !target.active {
        return Err("target workspace membership is inactive".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{space_id}\0{identity}\0{active}\0{expected_authz_epoch}"
    ));
    if existing_receipt(
        ctx,
        Some(space.workspace_id),
        "set_space_member",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let key = space_member_key(space_id, identity);
    if let Some(mut row) = ctx.db.space_member().key().find(key.clone()) {
        revision_matches(row.authz_epoch, expected_authz_epoch)?;
        row.active = active;
        row.authz_epoch = row.authz_epoch.saturating_add(1);
        row.updated_at = ctx.timestamp;
        ctx.db.space_member().key().update(row);
    } else {
        if expected_authz_epoch != 0 {
            return Err("new space membership must use expected epoch 0".into());
        }
        ctx.db.space_member().insert(SpaceMember {
            key,
            space_id,
            identity,
            active,
            authz_epoch: 1,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    }
    refresh_space_search_acl(ctx, space_id)?;
    for mut run in ctx.db.agent_run().workspace_id().filter(space.workspace_id) {
        if run.space_id == space_id && run.initiated_by == identity && !is_terminal(run.state) {
            cancel_open_agent_work(ctx, run.id);
            run.cancel_requested = true;
            run.state = AgentRunState::Revoked;
            run.lease_owner = None;
            run.lease_until = None;
            run.version = run.version.saturating_add(1);
            run.updated_at = ctx.timestamp;
            ctx.db.agent_run().id().update(run);
        }
    }
    insert_receipt(
        ctx,
        Some(space.workspace_id),
        "set_space_member",
        client_request_id,
        input_hash,
        "space_member",
        space_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: space.workspace_id,
            action: "set_space_member",
            resource_type: "space",
            resource_id: space_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "private-space membership updated",
        },
    )
}

#[spacetimedb::reducer]
pub fn create_post(
    ctx: &ReducerContext,
    space_id: Uuid,
    title: String,
    body: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    let (space, _) = require_space_action(ctx, space_id, Action::Write)?;
    validate_text(&title, "post title", 200)?;
    validate_text(&body, "post body", 50_000)?;
    let input_hash = normalized_input_hash(&format!("{space_id}\0{}\0{body}", title.trim()));
    if existing_receipt(
        ctx,
        Some(space.workspace_id),
        "create_post",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    let title = title.trim().to_string();
    ctx.db.post().insert(Post {
        id,
        workspace_id: space.workspace_id,
        space_id,
        author_identity: ctx.sender(),
        title: title.clone(),
        body: body.clone(),
        revision: 1,
        deleted: false,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    enqueue_search_snapshot(
        ctx,
        SearchSnapshotInput {
            workspace_id: space.workspace_id,
            space_id,
            resource_type: "post",
            resource_id: id,
            resource_revision: 1,
            title: &title,
            body: &body,
            tombstone: false,
        },
    )?;
    insert_receipt(
        ctx,
        Some(space.workspace_id),
        "create_post",
        client_request_id,
        input_hash,
        "post",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: space.workspace_id,
            action: "create_post",
            resource_type: "post",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: &format!("post created: {title}"),
        },
    )
}

#[spacetimedb::reducer]
pub fn edit_post(
    ctx: &ReducerContext,
    post_id: Uuid,
    title: String,
    body: String,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    validate_text(&title, "post title", 200)?;
    validate_text(&body, "post body", 50_000)?;
    let mut post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (_, member) = require_space_action(ctx, post.space_id, Action::Write)?;
    if post.author_identity != ctx.sender() && !role_allows(member.role, Action::ManageWorkspace) {
        return Err("only the author or an administrator may edit this post".into());
    }
    if post.deleted {
        return Err("deleted post cannot be edited".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{post_id}\0{}\0{body}\0{expected_revision}",
        title.trim()
    ));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "edit_post",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(post.revision, expected_revision)?;
    post.title = title.trim().into();
    post.body = body;
    post.revision = post.revision.saturating_add(1);
    post.updated_at = ctx.timestamp;
    ctx.db.post().id().update(post.clone());
    enqueue_search_snapshot(
        ctx,
        SearchSnapshotInput {
            workspace_id: post.workspace_id,
            space_id: post.space_id,
            resource_type: "post",
            resource_id: post.id,
            resource_revision: post.revision,
            title: &post.title,
            body: &post.body,
            tombstone: post.deleted,
        },
    )?;
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "edit_post",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: post.workspace_id,
            action: "edit_post",
            resource_type: "post",
            resource_id: post.id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: &format!("post revision advanced: {}", post.title),
        },
    )
}

#[spacetimedb::reducer]
pub fn delete_post(
    ctx: &ReducerContext,
    post_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (_, member) = require_space_action(ctx, post.space_id, Action::Write)?;
    if post.author_identity != ctx.sender() && !role_allows(member.role, Action::ManageWorkspace) {
        return Err("only the author or an administrator may delete this post".into());
    }
    let input_hash = normalized_input_hash(&format!("{post_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "delete_post",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(post.revision, expected_revision)?;
    if post.deleted {
        return Err("post is already deleted".into());
    }
    post.deleted = true;
    post.title.clear();
    post.body.clear();
    post.revision = post.revision.saturating_add(1);
    post.updated_at = ctx.timestamp;
    ctx.db.post().id().update(post.clone());
    enqueue_search_snapshot(
        ctx,
        SearchSnapshotInput {
            workspace_id: post.workspace_id,
            space_id: post.space_id,
            resource_type: "post",
            resource_id: post.id,
            resource_revision: post.revision,
            title: "",
            body: "",
            tombstone: true,
        },
    )?;
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "delete_post",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: post.workspace_id,
            action: "delete_post",
            resource_type: "post",
            resource_id: post.id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "post deleted and search tombstone queued",
        },
    )
}

#[spacetimedb::reducer]
pub fn create_named_thread(
    ctx: &ReducerContext,
    root_post_id: Uuid,
    title: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    validate_text(&title, "thread title", 200)?;
    let post = ctx
        .db
        .post()
        .id()
        .find(root_post_id)
        .ok_or_else(|| "root post not found".to_string())?;
    require_space_action(ctx, post.space_id, Action::Write)?;
    if post.deleted {
        return Err("deleted posts cannot receive new threads".into());
    }
    let input_hash = normalized_input_hash(&format!("{root_post_id}\0{}", title.trim()));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "create_named_thread",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.named_thread().insert(NamedThread {
        id,
        workspace_id: post.workspace_id,
        space_id: post.space_id,
        root_post_id,
        title: title.trim().into(),
        archived: false,
        revision: 1,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "create_named_thread",
        client_request_id,
        input_hash,
        "named_thread",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: post.workspace_id,
            action: "create_named_thread",
            resource_type: "named_thread",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "named thread created",
        },
    )
}

#[spacetimedb::reducer]
pub fn update_named_thread(
    ctx: &ReducerContext,
    thread_id: Uuid,
    title: String,
    archived: bool,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    validate_text(&title, "thread title", 200)?;
    let mut thread = ctx
        .db
        .named_thread()
        .id()
        .find(thread_id)
        .ok_or_else(|| "thread not found".to_string())?;
    let (_, member) = require_space_action(ctx, thread.space_id, Action::Write)?;
    if thread.created_by != ctx.sender() && !role_allows(member.role, Action::ManageWorkspace) {
        return Err("thread update denied".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{thread_id}\0{}\0{archived}\0{expected_revision}",
        title.trim()
    ));
    if existing_receipt(
        ctx,
        Some(thread.workspace_id),
        "update_named_thread",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(thread.revision, expected_revision)?;
    thread.title = title.trim().into();
    thread.archived = archived;
    thread.revision = thread.revision.saturating_add(1);
    thread.updated_at = ctx.timestamp;
    ctx.db.named_thread().id().update(thread.clone());
    refresh_space_search_acl(ctx, thread.space_id)?;
    insert_receipt(
        ctx,
        Some(thread.workspace_id),
        "update_named_thread",
        client_request_id,
        input_hash,
        "named_thread",
        thread.id,
    );
    Ok(())
}

fn insert_contribution_ancestry(
    ctx: &ReducerContext,
    contribution_id: Uuid,
    thread_id: Uuid,
    parent_id: Option<Uuid>,
) -> Result<(), String> {
    ctx.db.reply_ancestry().insert(ReplyAncestry {
        key: ancestry_key(contribution_id, contribution_id),
        ancestor_id: contribution_id,
        descendant_id: contribution_id,
        thread_id,
        depth: 0,
    });
    if let Some(parent_id) = parent_id {
        let parent = ctx
            .db
            .contribution()
            .id()
            .find(parent_id)
            .ok_or_else(|| "parent contribution not found".to_string())?;
        if parent.thread_id != thread_id {
            return Err("reply parent belongs to another thread".into());
        }
        if parent.deleted {
            return Err("deleted contributions cannot receive replies".into());
        }
        let ancestors: Vec<_> = ctx
            .db
            .reply_ancestry()
            .descendant_id()
            .filter(parent_id)
            .collect();
        let parent_depth = ancestors.iter().map(|row| row.depth).max().unwrap_or(0);
        if !crate::policy::reply_depth_allowed(parent_depth, MAX_REPLY_DEPTH) {
            return Err("maximum reply depth exceeded".into());
        }
        for ancestor in ancestors {
            ctx.db.reply_ancestry().insert(ReplyAncestry {
                key: ancestry_key(ancestor.ancestor_id, contribution_id),
                ancestor_id: ancestor.ancestor_id,
                descendant_id: contribution_id,
                thread_id,
                depth: ancestor.depth.saturating_add(1),
            });
        }
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn add_contribution(
    ctx: &ReducerContext,
    thread_id: Uuid,
    parent_contribution_id: Option<Uuid>,
    kind: ContributionKind,
    body: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    if kind == ContributionKind::AgentOutput {
        return Err("agent output can only be committed by the agent runtime".into());
    }
    validate_text(&body, "contribution body", 50_000)?;
    let thread = ctx
        .db
        .named_thread()
        .id()
        .find(thread_id)
        .ok_or_else(|| "thread not found".to_string())?;
    if thread.archived {
        return Err("thread is archived".into());
    }
    require_space_action(ctx, thread.space_id, Action::Write)?;
    let input_hash = normalized_input_hash(&format!(
        "{thread_id}\0{parent_contribution_id:?}\0{kind:?}\0{body}"
    ));
    if existing_receipt(
        ctx,
        Some(thread.workspace_id),
        "add_contribution",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    insert_contribution_ancestry(ctx, id, thread_id, parent_contribution_id)?;
    ctx.db.contribution().insert(Contribution {
        id,
        workspace_id: thread.workspace_id,
        thread_id,
        author_identity: ctx.sender(),
        agent_installation_id: None,
        agent_run_id: None,
        parent_contribution_id,
        kind,
        body: body.clone(),
        revision: 1,
        deleted: false,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    enqueue_search_snapshot(
        ctx,
        SearchSnapshotInput {
            workspace_id: thread.workspace_id,
            space_id: thread.space_id,
            resource_type: "contribution",
            resource_id: id,
            resource_revision: 1,
            title: &thread.title,
            body: &body,
            tombstone: false,
        },
    )?;
    insert_receipt(
        ctx,
        Some(thread.workspace_id),
        "add_contribution",
        client_request_id,
        input_hash,
        "contribution",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: thread.workspace_id,
            action: "add_contribution",
            resource_type: "contribution",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "thread contribution created",
        },
    )
}

fn contribution_write_authorized(
    ctx: &ReducerContext,
    contribution: &Contribution,
) -> Result<NamedThread, String> {
    let thread = ctx
        .db
        .named_thread()
        .id()
        .find(contribution.thread_id)
        .ok_or_else(|| "thread not found".to_string())?;
    let (_, member) = require_space_action(ctx, thread.space_id, Action::Write)?;
    if contribution.author_identity != ctx.sender()
        && !role_allows(member.role, Action::ManageWorkspace)
    {
        return Err("contribution update denied".into());
    }
    Ok(thread)
}

#[spacetimedb::reducer]
pub fn edit_contribution(
    ctx: &ReducerContext,
    contribution_id: Uuid,
    body: String,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    validate_text(&body, "contribution body", 50_000)?;
    let mut contribution = ctx
        .db
        .contribution()
        .id()
        .find(contribution_id)
        .ok_or_else(|| "contribution not found".to_string())?;
    let thread = contribution_write_authorized(ctx, &contribution)?;
    if contribution.kind == ContributionKind::AgentOutput
        && !role_allows(
            find_membership(ctx, contribution.workspace_id, ctx.sender())
                .ok_or_else(|| "membership required".to_string())?
                .role,
            Action::ManageWorkspace,
        )
    {
        return Err("agent output can only be edited by an administrator".into());
    }
    let input_hash =
        normalized_input_hash(&format!("{contribution_id}\0{body}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(contribution.workspace_id),
        "edit_contribution",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(contribution.revision, expected_revision)?;
    if contribution.deleted {
        return Err("deleted contribution cannot be edited".into());
    }
    contribution.body = body;
    contribution.revision = contribution.revision.saturating_add(1);
    contribution.updated_at = ctx.timestamp;
    ctx.db.contribution().id().update(contribution.clone());
    enqueue_search_snapshot(
        ctx,
        SearchSnapshotInput {
            workspace_id: contribution.workspace_id,
            space_id: thread.space_id,
            resource_type: "contribution",
            resource_id: contribution.id,
            resource_revision: contribution.revision,
            title: &thread.title,
            body: &contribution.body,
            tombstone: false,
        },
    )?;
    insert_receipt(
        ctx,
        Some(contribution.workspace_id),
        "edit_contribution",
        client_request_id,
        input_hash,
        "contribution",
        contribution.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn delete_contribution(
    ctx: &ReducerContext,
    contribution_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut contribution = ctx
        .db
        .contribution()
        .id()
        .find(contribution_id)
        .ok_or_else(|| "contribution not found".to_string())?;
    let thread = contribution_write_authorized(ctx, &contribution)?;
    let input_hash = normalized_input_hash(&format!("{contribution_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(contribution.workspace_id),
        "delete_contribution",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(contribution.revision, expected_revision)?;
    contribution.deleted = true;
    contribution.body.clear();
    contribution.revision = contribution.revision.saturating_add(1);
    contribution.updated_at = ctx.timestamp;
    ctx.db.contribution().id().update(contribution.clone());
    enqueue_search_snapshot(
        ctx,
        SearchSnapshotInput {
            workspace_id: contribution.workspace_id,
            space_id: thread.space_id,
            resource_type: "contribution",
            resource_id: contribution.id,
            resource_revision: contribution.revision,
            title: "",
            body: "",
            tombstone: true,
        },
    )?;
    insert_receipt(
        ctx,
        Some(contribution.workspace_id),
        "delete_contribution",
        client_request_id,
        input_hash,
        "contribution",
        contribution.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_decision(
    ctx: &ReducerContext,
    thread_id: Uuid,
    title: String,
    rationale: String,
    status: DecisionStatus,
    client_request_id: Uuid,
) -> Result<(), String> {
    if status != DecisionStatus::Proposed {
        return Err("new decisions must begin as proposed".into());
    }
    validate_text(&title, "decision title", 200)?;
    validate_text(&rationale, "decision rationale", 20_000)?;
    let thread = ctx
        .db
        .named_thread()
        .id()
        .find(thread_id)
        .ok_or_else(|| "thread not found".to_string())?;
    require_space_action(ctx, thread.space_id, Action::RecordDecisionOrTask)?;
    let input_hash = normalized_input_hash(&format!(
        "{thread_id}\0{}\0{rationale}\0{status:?}",
        title.trim()
    ));
    if existing_receipt(
        ctx,
        Some(thread.workspace_id),
        "record_decision",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.decision_record().insert(DecisionRecord {
        id,
        workspace_id: thread.workspace_id,
        thread_id,
        title: title.trim().into(),
        rationale,
        status,
        supersedes_decision_id: None,
        created_by: ctx.sender(),
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    insert_receipt(
        ctx,
        Some(thread.workspace_id),
        "record_decision",
        client_request_id,
        input_hash,
        "decision",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: thread.workspace_id,
            action: "record_decision",
            resource_type: "decision",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "decision recorded",
        },
    )
}

#[spacetimedb::reducer]
pub fn update_decision_status(
    ctx: &ReducerContext,
    decision_id: Uuid,
    next_status: DecisionStatus,
    supersedes_decision_id: Option<Uuid>,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut decision = ctx
        .db
        .decision_record()
        .id()
        .find(decision_id)
        .ok_or_else(|| "decision not found".to_string())?;
    let thread = ctx
        .db
        .named_thread()
        .id()
        .find(decision.thread_id)
        .ok_or_else(|| "decision thread not found".to_string())?;
    require_space_action(ctx, thread.space_id, Action::RecordDecisionOrTask)?;
    if !decision_transition_allowed(decision.status, next_status) {
        return Err("invalid decision status transition".into());
    }
    if let Some(other_id) = supersedes_decision_id {
        let other = ctx
            .db
            .decision_record()
            .id()
            .find(other_id)
            .ok_or_else(|| "superseded decision not found".to_string())?;
        if other.workspace_id != decision.workspace_id || other.thread_id != decision.thread_id {
            return Err("superseded decision must belong to the same thread".into());
        }
    }
    let input_hash = normalized_input_hash(&format!(
        "{decision_id}\0{next_status:?}\0{supersedes_decision_id:?}\0{expected_revision}"
    ));
    if existing_receipt(
        ctx,
        Some(decision.workspace_id),
        "update_decision_status",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(decision.revision, expected_revision)?;
    decision.status = next_status;
    decision.supersedes_decision_id = supersedes_decision_id;
    decision.revision = decision.revision.saturating_add(1);
    decision.updated_at = ctx.timestamp;
    ctx.db.decision_record().id().update(decision.clone());
    insert_receipt(
        ctx,
        Some(decision.workspace_id),
        "update_decision_status",
        client_request_id,
        input_hash,
        "decision",
        decision.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn create_task(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    thread_id: Option<Uuid>,
    assignee_identity: Identity,
    title: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    require_workspace_action(ctx, workspace_id, Action::RecordDecisionOrTask)?;
    validate_text(&title, "task title", 500)?;
    let assignee = find_membership(ctx, workspace_id, assignee_identity)
        .filter(|member| member.active)
        .ok_or_else(|| "assignee is not an active workspace member".to_string())?;
    if let Some(thread_id) = thread_id {
        let thread = ctx
            .db
            .named_thread()
            .id()
            .find(thread_id)
            .ok_or_else(|| "thread not found".to_string())?;
        if thread.workspace_id != workspace_id {
            return Err("thread belongs to another workspace".into());
        }
        let (space, _) = require_space_action(ctx, thread.space_id, Action::RecordDecisionOrTask)?;
        if !crate::policy::private_task_assignment_allowed(can_read_space(
            ctx,
            &space,
            assignee_identity,
        )) {
            return Err("assignee cannot access the task's private thread".into());
        }
    }
    let input_hash = normalized_input_hash(&format!(
        "{workspace_id}\0{thread_id:?}\0{assignee_identity}\0{}",
        title.trim()
    ));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "create_task",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.task_item().insert(TaskItem {
        id,
        workspace_id,
        thread_id,
        assignee_identity: assignee.identity,
        title: title.trim().into(),
        status: TaskStatus::Todo,
        created_by: ctx.sender(),
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    let notification_id = new_id(ctx)?;
    ctx.db.notification().insert(Notification {
        id: notification_id,
        workspace_id,
        recipient_identity: assignee.identity,
        kind: NotificationKind::Assignment,
        resource_type: "task".into(),
        resource_id: id,
        summary: "You were assigned a task".into(),
        read_at: None,
        created_at: ctx.timestamp,
    });
    enqueue_outbox(
        ctx,
        workspace_id,
        "deliver_notification",
        "notification",
        notification_id,
        0,
        format!("notification:{notification_id}"),
    )?;
    insert_receipt(
        ctx,
        Some(workspace_id),
        "create_task",
        client_request_id,
        input_hash,
        "task",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "create_task",
            resource_type: "task",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "task created",
        },
    )
}

#[spacetimedb::reducer]
pub fn update_task_status(
    ctx: &ReducerContext,
    task_id: Uuid,
    next_status: TaskStatus,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut task = ctx
        .db
        .task_item()
        .id()
        .find(task_id)
        .ok_or_else(|| "task not found".to_string())?;
    let membership = require_workspace_action(ctx, task.workspace_id, Action::Read)?;
    if task.assignee_identity != ctx.sender()
        && task.created_by != ctx.sender()
        && !role_allows(membership.role, Action::ManageWorkspace)
    {
        return Err("task status update denied".into());
    }
    if let Some(thread_id) = task.thread_id {
        let thread = ctx
            .db
            .named_thread()
            .id()
            .find(thread_id)
            .ok_or_else(|| "task thread not found".to_string())?;
        require_space_action(ctx, thread.space_id, Action::Read)?;
    }
    if !task_transition_allowed(task.status, next_status) {
        return Err("invalid task status transition".into());
    }
    let input_hash =
        normalized_input_hash(&format!("{task_id}\0{next_status:?}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(task.workspace_id),
        "update_task_status",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(task.revision, expected_revision)?;
    task.status = next_status;
    task.revision = task.revision.saturating_add(1);
    task.updated_at = ctx.timestamp;
    ctx.db.task_item().id().update(task.clone());
    insert_receipt(
        ctx,
        Some(task.workspace_id),
        "update_task_status",
        client_request_id,
        input_hash,
        "task",
        task.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn create_file_upload(ctx: &ReducerContext, input: FileUploadInput) -> Result<(), String> {
    let FileUploadInput {
        space_id,
        file_name,
        declared_size_bytes,
        checksum,
        client_request_id,
    } = input;
    let (space, _) = require_space_action(ctx, space_id, Action::Write)?;
    validate_text(&file_name, "file name", 500)?;
    validate_text(&checksum, "file checksum", 200)?;
    if declared_size_bytes == 0 || declared_size_bytes > 100 * 1024 * 1024 {
        return Err("file size must be between 1 byte and 100 MiB".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{space_id}\0{}\0{declared_size_bytes}\0{checksum}",
        file_name.trim()
    ));
    if existing_receipt(
        ctx,
        Some(space.workspace_id),
        "create_file_upload",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let file_id = new_id(ctx)?;
    let upload_id = new_id(ctx)?;
    let source_key = format!("uploads/{}/{file_id}/1", space.workspace_id);
    let cleanup_prefix = format!("tmp/{}/{file_id}/", space.workspace_id);
    ctx.db.file_record().insert(FileRecord {
        id: file_id,
        workspace_id: space.workspace_id,
        space_id,
        owner_identity: ctx.sender(),
        file_name: file_name.trim().into(),
        source_key: source_key.clone(),
        clean_key: String::new(),
        cleanup_prefix: cleanup_prefix.clone(),
        declared_size_bytes,
        checksum: checksum.clone(),
        detected_type: String::new(),
        scanner: String::new(),
        extracted_text: String::new(),
        state: FileSecurityState::UploadPending,
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.file_version().insert(FileVersion {
        key: file_version_key(file_id, 1),
        file_id,
        workspace_id: space.workspace_id,
        content_version: 1,
        source_key: source_key.clone(),
        clean_key: String::new(),
        declared_size_bytes,
        checksum,
        detected_type: String::new(),
        state: FileSecurityState::UploadPending,
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.file_upload().insert(FileUpload {
        id: upload_id,
        file_id,
        workspace_id: space.workspace_id,
        owner_identity: ctx.sender(),
        source_key,
        completed: false,
        expires_at: ctx.timestamp + TimeDuration::from_micros(3_600_000_000),
        created_at: ctx.timestamp,
        completed_at: None,
    });
    insert_receipt(
        ctx,
        Some(space.workspace_id),
        "create_file_upload",
        client_request_id,
        input_hash,
        "file",
        file_id,
    );
    Ok(())
}

fn validate_file_job_lease(
    ctx: &ReducerContext,
    job_id: Uuid,
    lease_generation: u64,
    file: &FileRecord,
    expected_kind: &str,
) -> Result<(), String> {
    let job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "file outbox job not found".to_string())?;
    require_service(ctx, file.workspace_id, expected_kind)?;
    if job.workspace_id != file.workspace_id
        || job.resource_type != "file"
        || job.resource_id != file.id
        || job.resource_revision != file.revision
        || job.kind != expected_kind
        || job.state != OutboxState::Leased
        || job.lease_owner != Some(ctx.sender())
        || job.lease_generation != lease_generation
        || job.lease_until.is_none_or(|expiry| expiry <= ctx.timestamp)
    {
        return Err("stale or mismatched file job lease".into());
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn complete_file_upload(
    ctx: &ReducerContext,
    file_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut file = ctx
        .db
        .file_record()
        .id()
        .find(file_id)
        .ok_or_else(|| "file not found".to_string())?;
    let (_, member) = require_space_action(ctx, file.space_id, Action::Write)?;
    if file.owner_identity != ctx.sender() && !role_allows(member.role, Action::ManageWorkspace) {
        return Err("file upload completion denied".into());
    }
    let input_hash = normalized_input_hash(&format!("{file_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(file.workspace_id),
        "complete_file_upload",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(file.revision, expected_revision)?;
    if file.state != FileSecurityState::UploadPending {
        return Err("file is not awaiting upload completion".into());
    }
    let mut upload = ctx
        .db
        .file_upload()
        .file_id()
        .find(file_id)
        .ok_or_else(|| "upload session not found".to_string())?;
    if upload.completed || upload.expires_at <= ctx.timestamp {
        return Err("upload session is completed or expired".into());
    }
    upload.completed = true;
    upload.completed_at = Some(ctx.timestamp);
    ctx.db.file_upload().id().update(upload);
    file.state = FileSecurityState::Uploaded;
    file.revision = file.revision.saturating_add(1);
    file.updated_at = ctx.timestamp;
    ctx.db.file_record().id().update(file.clone());
    let mut version = ctx
        .db
        .file_version()
        .key()
        .find(file_version_key(file_id, 1))
        .ok_or_else(|| "file version not found".to_string())?;
    version.state = FileSecurityState::Uploaded;
    version.revision = version.revision.saturating_add(1);
    version.updated_at = ctx.timestamp;
    ctx.db.file_version().key().update(version);
    enqueue_outbox(
        ctx,
        file.workspace_id,
        "file_scan",
        "file",
        file.id,
        file.revision,
        format!("file:{file_id}:scan:{}", file.revision),
    )?;
    insert_receipt(
        ctx,
        Some(file.workspace_id),
        "complete_file_upload",
        client_request_id,
        input_hash,
        "file",
        file.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_file_scan_outcome(
    ctx: &ReducerContext,
    input: FileScanOutcomeInput,
) -> Result<(), String> {
    let FileScanOutcomeInput {
        job_id,
        lease_generation,
        file_id,
        expected_revision,
        detected_type,
        clean,
        clean_key,
        scanner,
    } = input;
    validate_text(&detected_type, "detected file type", 200)?;
    validate_text(&scanner, "scanner", 200)?;
    let mut file = ctx
        .db
        .file_record()
        .id()
        .find(file_id)
        .ok_or_else(|| "file not found".to_string())?;
    validate_file_job_lease(ctx, job_id, lease_generation, &file, "file_scan")?;
    revision_matches(file.revision, expected_revision)?;
    if file.state != FileSecurityState::Uploaded && file.state != FileSecurityState::Scanning {
        return Err("file is not scannable".into());
    }
    let allowed = matches!(
        detected_type.as_str(),
        "text/plain" | "application/pdf" | "image/png" | "image/jpeg"
    );
    let expected_clean_key = format!("clean/{}/{file_id}/1", file.workspace_id);
    if clean && (!allowed || clean_key != expected_clean_key) {
        return Err("clean file result violates type or destination policy".into());
    }
    file.detected_type = detected_type.clone();
    file.scanner = scanner;
    file.clean_key = if clean {
        clean_key.clone()
    } else {
        String::new()
    };
    file.state = if clean {
        FileSecurityState::Clean
    } else {
        FileSecurityState::Rejected
    };
    file.revision = file.revision.saturating_add(1);
    file.updated_at = ctx.timestamp;
    ctx.db.file_record().id().update(file.clone());
    let mut version = ctx
        .db
        .file_version()
        .key()
        .find(file_version_key(file_id, 1))
        .ok_or_else(|| "file version not found".to_string())?;
    version.detected_type = detected_type;
    version.clean_key = file.clean_key.clone();
    version.state = file.state;
    version.revision = version.revision.saturating_add(1);
    version.updated_at = ctx.timestamp;
    ctx.db.file_version().key().update(version);
    if clean {
        enqueue_outbox(
            ctx,
            file.workspace_id,
            "file_extract",
            "file",
            file.id,
            file.revision,
            format!("file:{file_id}:extract:{}", file.revision),
        )?;
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_file_extraction(
    ctx: &ReducerContext,
    input: FileExtractionInput,
) -> Result<(), String> {
    let FileExtractionInput {
        job_id,
        lease_generation,
        file_id,
        expected_revision,
        extracted_text,
    } = input;
    if extracted_text.len() > 100_000 {
        return Err("extracted text exceeds 100000 bytes".into());
    }
    let mut file = ctx
        .db
        .file_record()
        .id()
        .find(file_id)
        .ok_or_else(|| "file not found".to_string())?;
    validate_file_job_lease(ctx, job_id, lease_generation, &file, "file_extract")?;
    revision_matches(file.revision, expected_revision)?;
    if file.state != FileSecurityState::Clean {
        return Err("only clean files may record extraction".into());
    }
    file.extracted_text = extracted_text;
    file.state = FileSecurityState::Extracted;
    file.revision = file.revision.saturating_add(1);
    file.updated_at = ctx.timestamp;
    ctx.db.file_record().id().update(file);
    let mut version = ctx
        .db
        .file_version()
        .key()
        .find(file_version_key(file_id, 1))
        .ok_or_else(|| "file version not found".to_string())?;
    version.state = FileSecurityState::Extracted;
    version.revision = version.revision.saturating_add(1);
    version.updated_at = ctx.timestamp;
    ctx.db.file_version().key().update(version);
    Ok(())
}

#[spacetimedb::reducer]
pub fn delete_file(
    ctx: &ReducerContext,
    file_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut file = ctx
        .db
        .file_record()
        .id()
        .find(file_id)
        .ok_or_else(|| "file not found".to_string())?;
    let (_, member) = require_space_action(ctx, file.space_id, Action::Write)?;
    if file.owner_identity != ctx.sender() && !role_allows(member.role, Action::ManageWorkspace) {
        return Err("file deletion denied".into());
    }
    let input_hash = normalized_input_hash(&format!("{file_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(file.workspace_id),
        "delete_file",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(file.revision, expected_revision)?;
    file.state = FileSecurityState::Deleted;
    file.revision = file.revision.saturating_add(1);
    file.updated_at = ctx.timestamp;
    ctx.db.file_record().id().update(file.clone());
    let mut version = ctx
        .db
        .file_version()
        .key()
        .find(file_version_key(file_id, 1))
        .ok_or_else(|| "file version not found".to_string())?;
    version.state = FileSecurityState::Deleted;
    version.revision = version.revision.saturating_add(1);
    version.updated_at = ctx.timestamp;
    ctx.db.file_version().key().update(version);
    enqueue_outbox(
        ctx,
        file.workspace_id,
        "file_cleanup",
        "file",
        file.id,
        file.revision,
        format!("file:{file_id}:cleanup:{}", file.revision),
    )?;
    insert_receipt(
        ctx,
        Some(file.workspace_id),
        "delete_file",
        client_request_id,
        input_hash,
        "file",
        file.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn mark_notification_read(ctx: &ReducerContext, notification_id: Uuid) -> Result<(), String> {
    require_registered_user(ctx)?;
    let mut row = ctx
        .db
        .notification()
        .id()
        .find(notification_id)
        .ok_or_else(|| "notification not found".to_string())?;
    if row.recipient_identity != ctx.sender()
        || !can_read_workspace(ctx, row.workspace_id, ctx.sender())
    {
        return Err("notification access denied".into());
    }
    if row.read_at.is_none() {
        row.read_at = Some(ctx.timestamp);
        ctx.db.notification().id().update(row);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn register_service_principal(
    ctx: &ReducerContext,
    identity: Identity,
    name: String,
    can_run_agents: bool,
    can_process_outbox: bool,
    client_request_id: Uuid,
) -> Result<(), String> {
    let caller_subject = verified_oidc_subject(ctx)?;
    validate_text(&name, "service name", 120)?;
    let input_hash = normalized_input_hash(&format!(
        "{identity}\0{}\0{can_run_agents}\0{can_process_outbox}",
        name.trim()
    ));
    if existing_platform_receipt(
        ctx,
        "register_service_principal",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let operator_subject = require_service_provision_operator(ctx, true)?;
    let row = ServicePrincipal {
        identity,
        name: name.trim().into(),
        enabled: true,
        can_run_agents,
        can_process_outbox,
        authz_epoch: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };
    let committed_revision =
        if let Some(existing) = ctx.db.service_principal().identity().find(identity) {
            let committed_revision = existing.authz_epoch.saturating_add(1);
            ctx.db
                .service_principal()
                .identity()
                .update(ServicePrincipal {
                    authz_epoch: committed_revision,
                    created_at: existing.created_at,
                    ..row
                });
            committed_revision
        } else {
            ctx.db.service_principal().insert(row);
            1
        };
    insert_platform_receipt(
        ctx,
        "register_service_principal",
        client_request_id,
        input_hash,
        operator_subject.clone(),
        committed_revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &operator_subject,
            workspace_id: None,
            action: "register_service_principal",
            resource: format!("service_principal:{identity}"),
            request_id: client_request_id,
            summary: "service principal configuration updated",
        },
    )
}

#[spacetimedb::reducer]
pub fn set_service_grant(
    ctx: &ReducerContext,
    service_identity: Identity,
    workspace_id: Uuid,
    kind: String,
    enabled: bool,
    client_request_id: Uuid,
) -> Result<(), String> {
    let caller_subject = verified_oidc_subject(ctx)?;
    validate_text(&kind, "service grant kind", 120)?;
    let input_hash = normalized_input_hash(&format!(
        "{service_identity}\0{workspace_id}\0{}\0{enabled}",
        kind.trim()
    ));
    if existing_platform_receipt(
        ctx,
        "set_service_grant",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let operator_subject = require_service_provision_operator(ctx, true)?;
    ctx.db
        .service_principal()
        .identity()
        .find(service_identity)
        .filter(|service| service.enabled)
        .ok_or_else(|| "enabled service principal required".to_string())?;
    ctx.db
        .workspace()
        .id()
        .find(workspace_id)
        .ok_or_else(|| "workspace not found".to_string())?;
    let key = service_grant_key(service_identity, workspace_id, &kind);
    let committed_revision = if let Some(mut grant) = ctx.db.service_grant().key().find(key.clone())
    {
        grant.enabled = enabled;
        grant.authz_epoch = grant.authz_epoch.saturating_add(1);
        let committed_revision = grant.authz_epoch;
        grant.updated_at = ctx.timestamp;
        ctx.db.service_grant().key().update(grant);
        committed_revision
    } else {
        ctx.db.service_grant().insert(ServiceGrant {
            key: key.clone(),
            service_identity,
            workspace_id,
            kind,
            enabled,
            authz_epoch: 1,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
        1
    };
    insert_platform_receipt(
        ctx,
        "set_service_grant",
        client_request_id,
        input_hash,
        operator_subject.clone(),
        committed_revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &operator_subject,
            workspace_id: Some(workspace_id),
            action: "set_service_grant",
            resource: format!("service_grant:{key}"),
            request_id: client_request_id,
            summary: "workspace-scoped service grant updated",
        },
    )
}

#[spacetimedb::reducer]
pub fn register_trusted_tool(
    ctx: &ReducerContext,
    tool_name: String,
    tool_version: String,
    capability: AgentCapability,
    effect_class: ToolEffectClass,
    enabled: bool,
    client_request_id: Uuid,
) -> Result<(), String> {
    let caller_subject = verified_oidc_subject(ctx)?;
    validate_text(&tool_name, "tool name", 200)?;
    validate_text(&tool_version, "tool version", 120)?;
    if !matches!(
        capability,
        AgentCapability::UseReadTool | AgentCapability::UseExternalTool
    ) {
        return Err("trusted tool must use a tool capability".into());
    }
    if !crate::policy::trusted_tool_binding_valid(
        effect_class == ToolEffectClass::Read,
        capability == AgentCapability::UseReadTool,
    ) {
        return Err("trusted tool capability and effect class disagree".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{}\0{}\0{capability:?}\0{effect_class:?}\0{enabled}",
        tool_name.trim(),
        tool_version.trim()
    ));
    if existing_platform_receipt(
        ctx,
        "register_trusted_tool",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let operator_subject = require_service_provision_operator(ctx, true)?;
    let fenced_tool_name = tool_name.clone();
    let fenced_tool_version = tool_version.clone();
    let key = trusted_tool_key(&tool_name, &tool_version);
    let committed_revision =
        if let Some(mut existing) = ctx.db.trusted_tool().key().find(key.clone()) {
            if existing.capability != capability || existing.effect_class != effect_class {
                return Err("trusted tool classification is immutable".into());
            }
            existing.enabled = enabled;
            existing.revision = existing.revision.saturating_add(1);
            let committed_revision = existing.revision;
            existing.configured_at = ctx.timestamp;
            ctx.db.trusted_tool().key().update(existing);
            committed_revision
        } else {
            ctx.db.trusted_tool().insert(TrustedTool {
                key: key.clone(),
                tool_name,
                tool_version,
                capability,
                effect_class,
                enabled,
                revision: 1,
                configured_at: ctx.timestamp,
            });
            1
        };
    fence_tool_calls_for_catalog_change(ctx, &fenced_tool_name, &fenced_tool_version);
    insert_platform_receipt(
        ctx,
        "register_trusted_tool",
        client_request_id,
        input_hash,
        operator_subject.clone(),
        committed_revision,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &operator_subject,
            workspace_id: None,
            action: "register_trusted_tool",
            resource: format!("trusted_tool:{key}"),
            request_id: client_request_id,
            summary: "trusted tool configuration updated",
        },
    )
}

#[spacetimedb::reducer]
pub fn install_agent(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    input: InstallAgentInput,
) -> Result<(), String> {
    let InstallAgentInput {
        name,
        provider,
        model,
        secret_ref,
        max_run_tokens,
        max_run_cost_micros,
        max_attempts,
        max_age_seconds,
        client_request_id,
    } = input;
    require_workspace_action(ctx, workspace_id, Action::ManageAgents)?;
    validate_text(&name, "agent name", 120)?;
    validate_text(&provider, "agent provider", 120)?;
    validate_text(&model, "agent model", 200)?;
    validate_text(&secret_ref, "secret reference", 500)?;
    if max_run_tokens == 0 || max_run_cost_micros == 0 {
        return Err("agent budgets must be positive".into());
    }
    if !(1..=20).contains(&max_attempts) || !(60..=604_800).contains(&max_age_seconds) {
        return Err("agent max attempts must be 1-20 and max age 60-604800 seconds".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{workspace_id}\0{}\0{}\0{}\0{secret_ref}\0{max_run_tokens}\0{max_run_cost_micros}\0{max_attempts}\0{max_age_seconds}",
        name.trim(),
        provider.trim(),
        model.trim()
    ));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "install_agent",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.agent_installation().insert(AgentInstallation {
        id,
        workspace_id,
        name: name.trim().into(),
        provider: provider.trim().into(),
        model: model.trim().into(),
        secret_ref,
        enabled: true,
        authz_epoch: 1,
        max_run_tokens,
        max_run_cost_micros,
        max_attempts,
        max_age_seconds,
        installed_by: ctx.sender(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    insert_receipt(
        ctx,
        Some(workspace_id),
        "install_agent",
        client_request_id,
        input_hash,
        "agent_installation",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "install_agent",
            resource_type: "agent_installation",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "agent installation created without storing credential material",
        },
    )
}

#[spacetimedb::reducer]
pub fn set_agent_scope(
    ctx: &ReducerContext,
    installation_id: Uuid,
    space_id: Option<Uuid>,
    capability: AgentCapability,
    enabled: bool,
    expected_installation_epoch: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut installation = ctx
        .db
        .agent_installation()
        .id()
        .find(installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    require_workspace_action(ctx, installation.workspace_id, Action::ManageAgents)?;
    if let Some(space_id) = space_id {
        let space = ctx
            .db
            .space()
            .id()
            .find(space_id)
            .ok_or_else(|| "scope space not found".to_string())?;
        if space.workspace_id != installation.workspace_id {
            return Err("scope space belongs to another workspace".into());
        }
    }
    let input_hash = normalized_input_hash(&format!(
        "{installation_id}\0{space_id:?}\0{capability:?}\0{enabled}\0{expected_installation_epoch}"
    ));
    if existing_receipt(
        ctx,
        Some(installation.workspace_id),
        "set_agent_scope",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(installation.authz_epoch, expected_installation_epoch)?;
    let key = agent_scope_key(installation_id, space_id, capability);
    let row = AgentScope {
        key: key.clone(),
        installation_id,
        space_id,
        capability,
        enabled,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };
    if let Some(existing) = ctx.db.agent_scope().key().find(key) {
        ctx.db.agent_scope().key().update(AgentScope {
            created_at: existing.created_at,
            ..row
        });
    } else {
        ctx.db.agent_scope().insert(row);
    }
    installation.authz_epoch = installation.authz_epoch.saturating_add(1);
    installation.updated_at = ctx.timestamp;
    ctx.db
        .agent_installation()
        .id()
        .update(installation.clone());
    for mut run in ctx.db.agent_run().installation_id().filter(installation_id) {
        if !is_terminal(run.state) {
            cancel_open_agent_work(ctx, run.id);
            run.cancel_requested = true;
            run.state = AgentRunState::Revoked;
            run.lease_owner = None;
            run.lease_until = None;
            run.version = run.version.saturating_add(1);
            run.updated_at = ctx.timestamp;
            ctx.db.agent_run().id().update(run);
        }
    }
    insert_receipt(
        ctx,
        Some(installation.workspace_id),
        "set_agent_scope",
        client_request_id,
        input_hash,
        "agent_installation",
        installation.id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: installation.workspace_id,
            action: "set_agent_scope",
            resource_type: "agent_installation",
            resource_id: installation.id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "agent authorization epoch advanced",
        },
    )
}

#[spacetimedb::reducer]
pub fn set_agent_tool_policy(
    ctx: &ReducerContext,
    input: SetAgentToolPolicyInput,
) -> Result<(), String> {
    let SetAgentToolPolicyInput {
        installation_id,
        tool_name,
        tool_version,
        capability,
        requires_approval,
        approval_ttl_seconds,
        enabled,
        expected_installation_epoch,
        client_request_id,
    } = input;
    let mut installation = ctx
        .db
        .agent_installation()
        .id()
        .find(installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    require_workspace_action(ctx, installation.workspace_id, Action::ManageAgents)?;
    for (value, field, max) in [
        (&tool_name, "tool name", 200),
        (&tool_version, "tool version", 120),
    ] {
        validate_text(value, field, max)?;
    }
    let trusted = ctx
        .db
        .trusted_tool()
        .key()
        .find(trusted_tool_key(&tool_name, &tool_version))
        .filter(|tool| tool.enabled)
        .ok_or_else(|| "tool is not present in the trusted catalog".to_string())?;
    if trusted.capability != capability {
        return Err("tool capability does not match trusted catalog".into());
    }
    let effect_class = trusted.effect_class;
    if !tool_policy_valid(effect_class, requires_approval) {
        return Err("side-effecting tools always require human approval".into());
    }
    if (requires_approval && !(30..=3_600).contains(&approval_ttl_seconds))
        || (!requires_approval && approval_ttl_seconds != 0)
    {
        return Err("approval TTL must be 30-3600 seconds when required, otherwise 0".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{installation_id}\0{tool_name}\0{tool_version}\0{capability:?}\0{requires_approval}\0{approval_ttl_seconds}\0{enabled}\0{expected_installation_epoch}"
    ));
    if existing_receipt(
        ctx,
        Some(installation.workspace_id),
        "set_agent_tool_policy",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(installation.authz_epoch, expected_installation_epoch)?;
    let key = agent_tool_policy_key(installation_id, &tool_name, &tool_version);
    let revision;
    if let Some(existing) = ctx.db.agent_tool_policy().key().find(key.clone()) {
        revision = existing.revision.saturating_add(1);
        ctx.db.agent_tool_policy().key().update(AgentToolPolicy {
            key,
            installation_id,
            tool_name,
            tool_version,
            capability,
            effect_class,
            trusted_tool_revision: trusted.revision,
            requires_approval,
            approval_ttl_seconds,
            enabled,
            revision,
            configured_by: ctx.sender(),
            created_at: existing.created_at,
            updated_at: ctx.timestamp,
        });
    } else {
        revision = 1;
        ctx.db.agent_tool_policy().insert(AgentToolPolicy {
            key,
            installation_id,
            tool_name,
            tool_version,
            capability,
            effect_class,
            trusted_tool_revision: trusted.revision,
            requires_approval,
            approval_ttl_seconds,
            enabled,
            revision,
            configured_by: ctx.sender(),
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    }
    installation.authz_epoch = installation.authz_epoch.saturating_add(1);
    installation.updated_at = ctx.timestamp;
    ctx.db
        .agent_installation()
        .id()
        .update(installation.clone());
    for mut run in ctx.db.agent_run().installation_id().filter(installation_id) {
        if !is_terminal(run.state) {
            cancel_open_agent_work(ctx, run.id);
            run.cancel_requested = true;
            run.state = AgentRunState::Revoked;
            run.lease_owner = None;
            run.lease_until = None;
            run.version = run.version.saturating_add(1);
            run.updated_at = ctx.timestamp;
            ctx.db.agent_run().id().update(run);
        }
    }
    insert_receipt(
        ctx,
        Some(installation.workspace_id),
        "set_agent_tool_policy",
        client_request_id,
        input_hash,
        "agent_tool_policy",
        installation.id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: installation.workspace_id,
            action: "set_agent_tool_policy",
            resource_type: "agent_tool_policy",
            resource_id: installation.id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: &format!("tool policy revision {revision} configured"),
        },
    )
}

#[spacetimedb::reducer]
pub fn revoke_agent(
    ctx: &ReducerContext,
    installation_id: Uuid,
    expected_installation_epoch: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut installation = ctx
        .db
        .agent_installation()
        .id()
        .find(installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    require_workspace_action(ctx, installation.workspace_id, Action::ManageAgents)?;
    let input_hash =
        normalized_input_hash(&format!("{installation_id}\0{expected_installation_epoch}"));
    if existing_receipt(
        ctx,
        Some(installation.workspace_id),
        "revoke_agent",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(installation.authz_epoch, expected_installation_epoch)?;
    installation.enabled = false;
    installation.authz_epoch = installation.authz_epoch.saturating_add(1);
    installation.updated_at = ctx.timestamp;
    ctx.db
        .agent_installation()
        .id()
        .update(installation.clone());
    for mut run in ctx.db.agent_run().installation_id().filter(installation_id) {
        if !is_terminal(run.state) {
            cancel_open_agent_work(ctx, run.id);
            run.cancel_requested = true;
            run.state = AgentRunState::Revoked;
            run.lease_owner = None;
            run.lease_until = None;
            run.version = run.version.saturating_add(1);
            run.updated_at = ctx.timestamp;
            ctx.db.agent_run().id().update(run);
        }
    }
    insert_receipt(
        ctx,
        Some(installation.workspace_id),
        "revoke_agent",
        client_request_id,
        input_hash,
        "agent_installation",
        installation.id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: installation.workspace_id,
            action: "revoke_agent",
            resource_type: "agent_installation",
            resource_id: installation.id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "agent disabled and active runs revoked",
        },
    )
}

#[spacetimedb::reducer]
pub fn start_agent_run(
    ctx: &ReducerContext,
    installation_id: Uuid,
    thread_id: Uuid,
    prompt_summary: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    validate_text(&prompt_summary, "prompt summary", 4_000)?;
    let thread = ctx
        .db
        .named_thread()
        .id()
        .find(thread_id)
        .ok_or_else(|| "thread not found".to_string())?;
    if thread.archived {
        return Err("archived threads cannot start agent runs".into());
    }
    let (_, member) = require_space_action(ctx, thread.space_id, Action::RunAgent)?;
    let installation = ctx
        .db
        .agent_installation()
        .id()
        .find(installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    if installation.workspace_id != thread.workspace_id || !installation.enabled {
        return Err("agent installation unavailable in this workspace".into());
    }
    if !agent_scope_enabled(
        ctx,
        installation_id,
        thread.space_id,
        AgentCapability::ReadSpace,
    ) {
        return Err("agent lacks read scope for this space".into());
    }
    let input_hash =
        normalized_input_hash(&format!("{installation_id}\0{thread_id}\0{prompt_summary}"));
    if existing_receipt(
        ctx,
        Some(thread.workspace_id),
        "start_agent_run",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    ctx.db.agent_run().insert(AgentRun {
        id,
        workspace_id: thread.workspace_id,
        installation_id,
        space_id: thread.space_id,
        thread_id: Some(thread_id),
        initiated_by: ctx.sender(),
        state: AgentRunState::Queued,
        version: 1,
        installation_epoch: installation.authz_epoch,
        membership_epoch: member.authz_epoch,
        attempt: 0,
        cancel_requested: false,
        lease_owner: None,
        lease_until: None,
        lease_generation: 0,
        expires_at: ctx.timestamp
            + TimeDuration::from_micros(i64::from(installation.max_age_seconds) * 1_000_000),
        next_event_sequence: 1,
        prompt_summary,
        output_summary: String::new(),
        used_tokens: 0,
        used_cost_micros: 0,
        final_contribution_id: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.agent_run_event().insert(AgentRunEvent {
        id: new_id(ctx)?,
        run_id: id,
        sequence: 0,
        run_sequence_key: format!("{id}:0"),
        kind: "queued".into(),
        summary: "Agent run queued".into(),
        created_at: ctx.timestamp,
    });
    insert_receipt(
        ctx,
        Some(thread.workspace_id),
        "start_agent_run",
        client_request_id,
        input_hash,
        "agent_run",
        id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: thread.workspace_id,
            action: "start_agent_run",
            resource_type: "agent_run",
            resource_id: id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "agent run requested with bounded space context",
        },
    )
}

#[spacetimedb::reducer]
pub fn claim_agent_run(
    ctx: &ReducerContext,
    run_id: Uuid,
    expected_version: u64,
    lease_seconds: u32,
) -> Result<(), String> {
    if !(1..=300).contains(&lease_seconds) {
        return Err("agent lease must be between 1 and 300 seconds".into());
    }
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    revision_matches(run.version, expected_version)?;
    let installation = ctx
        .db
        .agent_installation()
        .id()
        .find(run.installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    if run.attempt >= installation.max_attempts || run.expires_at <= ctx.timestamp {
        cancel_open_agent_work(ctx, run.id);
        run.state = AgentRunState::Expired;
        run.cancel_requested = true;
        run.lease_owner = None;
        run.lease_until = None;
        run.version = run.version.saturating_add(1);
        run.updated_at = ctx.timestamp;
        ctx.db.agent_run().id().update(run);
        return Ok(());
    }
    let lease_expired = run.lease_until.is_none_or(|expiry| expiry <= ctx.timestamp);
    let age_seconds = ctx
        .timestamp
        .duration_since(run.created_at)
        .map(|duration| duration.as_secs())
        .unwrap_or(u64::MAX);
    if !crate::policy::lease_claimable(
        is_terminal(run.state) || run.cancel_requested,
        run.state == AgentRunState::Queued,
        lease_expired,
        run.attempt,
        installation.max_attempts,
        age_seconds,
        u64::from(installation.max_age_seconds),
    ) {
        return Err("agent run is not claimable".into());
    }
    let membership = find_membership(ctx, run.workspace_id, run.initiated_by)
        .ok_or_else(|| "initiating membership not found".to_string())?;
    if !installation.enabled
        || installation.authz_epoch != run.installation_epoch
        || !membership.active
        || membership.authz_epoch != run.membership_epoch
    {
        return Err("agent authorization was revoked before claim".into());
    }
    if run.state == AgentRunState::Queued {
        run.state = AgentRunState::Authorizing;
    }
    run.version = run.version.saturating_add(1);
    run.attempt = run.attempt.saturating_add(1);
    run.lease_owner = Some(ctx.sender());
    run.lease_until =
        Some(ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000));
    run.lease_generation = run.lease_generation.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn heartbeat_agent_run(
    ctx: &ReducerContext,
    run_id: Uuid,
    lease_generation: u64,
    lease_seconds: u32,
) -> Result<(), String> {
    if !(1..=300).contains(&lease_seconds) {
        return Err("agent lease must be between 1 and 300 seconds".into());
    }
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if is_terminal(run.state) {
        return Err("terminal agent runs cannot be renewed".into());
    }
    run.lease_until =
        Some(ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000));
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn append_agent_run_event(
    ctx: &ReducerContext,
    run_id: Uuid,
    lease_generation: u64,
    expected_version: u64,
    next_state: AgentRunState,
    kind: String,
    summary: String,
) -> Result<(), String> {
    validate_text(&kind, "event kind", 120)?;
    validate_text(&summary, "event summary", 4_000)?;
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    revision_matches(run.version, expected_version)?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if !agent_event_transition_allowed(run.state, next_state) {
        return Err("invalid agent state transition".into());
    }
    let sequence = run.next_event_sequence;
    run.next_event_sequence = run.next_event_sequence.saturating_add(1);
    run.state = next_state;
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    ctx.db.agent_run_event().insert(AgentRunEvent {
        id: new_id(ctx)?,
        run_id,
        sequence,
        run_sequence_key: format!("{run_id}:{sequence}"),
        kind,
        summary,
        created_at: ctx.timestamp,
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_agent_context_post(
    ctx: &ReducerContext,
    input: AgentContextPostInput,
) -> Result<(), String> {
    let AgentContextPostInput {
        run_id,
        lease_generation,
        post_id,
        expected_revision,
        source_hash,
        trust_class,
        redaction_summary,
    } = input;
    validate_text(&source_hash, "context source hash", 200)?;
    validate_text(&trust_class, "context trust class", 120)?;
    if redaction_summary.len() > 2_000 {
        return Err("context redaction summary exceeds 2000 bytes".into());
    }
    let run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if run.state != AgentRunState::CollectingContext {
        return Err("context may only be recorded while collecting context".into());
    }
    if !agent_scope_enabled(
        ctx,
        run.installation_id,
        run.space_id,
        AgentCapability::ReadSpace,
    ) {
        return Err("agent no longer has context read scope".into());
    }
    let post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "context post not found".to_string())?;
    if post.workspace_id != run.workspace_id || post.space_id != run.space_id || post.deleted {
        return Err("context post is outside the authorized run scope".into());
    }
    revision_matches(post.revision, expected_revision)?;
    let run_resource_key = format!("{run_id}:post:{post_id}:{}", post.revision);
    if let Some(existing) = ctx
        .db
        .agent_context_manifest()
        .run_resource_key()
        .find(run_resource_key.clone())
    {
        return if existing.source_hash == source_hash {
            Ok(())
        } else {
            Err("context manifest replay hash mismatch".into())
        };
    }
    if ctx
        .db
        .agent_context_manifest()
        .run_id()
        .filter(run_id)
        .count()
        >= 64
    {
        return Err("agent context manifest is limited to 64 resources".into());
    }
    ctx.db
        .agent_context_manifest()
        .insert(AgentContextManifest {
            id: new_id(ctx)?,
            run_id,
            run_resource_key,
            resource_type: "post".into(),
            resource_id: post_id,
            resource_revision: post.revision,
            source_hash,
            trust_class,
            redaction_summary,
            policy_version: POLICY_VERSION,
            created_at: ctx.timestamp,
        });
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_agent_context_contribution(
    ctx: &ReducerContext,
    input: AgentContextContributionInput,
) -> Result<(), String> {
    let AgentContextContributionInput {
        run_id,
        lease_generation,
        contribution_id,
        expected_revision,
        source_hash,
        trust_class,
        redaction_summary,
    } = input;
    validate_text(&source_hash, "context source hash", 200)?;
    validate_text(&trust_class, "context trust class", 120)?;
    if redaction_summary.len() > 2_000 {
        return Err("context redaction summary exceeds 2000 bytes".into());
    }
    let run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if run.state != AgentRunState::CollectingContext
        || !agent_scope_enabled(
            ctx,
            run.installation_id,
            run.space_id,
            AgentCapability::ReadHistory,
        )
    {
        return Err("agent lacks active bounded history scope".into());
    }
    let contribution = ctx
        .db
        .contribution()
        .id()
        .find(contribution_id)
        .ok_or_else(|| "context contribution not found".to_string())?;
    if contribution.deleted
        || contribution.workspace_id != run.workspace_id
        || Some(contribution.thread_id) != run.thread_id
    {
        return Err("context contribution is outside the authorized thread".into());
    }
    revision_matches(contribution.revision, expected_revision)?;
    let run_resource_key = format!(
        "{run_id}:contribution:{contribution_id}:{}",
        contribution.revision
    );
    if let Some(existing) = ctx
        .db
        .agent_context_manifest()
        .run_resource_key()
        .find(run_resource_key.clone())
    {
        return if existing.source_hash == source_hash {
            Ok(())
        } else {
            Err("context manifest replay hash mismatch".into())
        };
    }
    if ctx
        .db
        .agent_context_manifest()
        .run_id()
        .filter(run_id)
        .count()
        >= 64
    {
        return Err("agent context manifest is limited to 64 resources".into());
    }
    ctx.db
        .agent_context_manifest()
        .insert(AgentContextManifest {
            id: new_id(ctx)?,
            run_id,
            run_resource_key,
            resource_type: "contribution".into(),
            resource_id: contribution.id,
            resource_revision: contribution.revision,
            source_hash,
            trust_class,
            redaction_summary,
            policy_version: POLICY_VERSION,
            created_at: ctx.timestamp,
        });
    Ok(())
}

#[spacetimedb::reducer]
pub fn request_agent_tool_call(
    ctx: &ReducerContext,
    input: AgentToolCallInput,
) -> Result<(), String> {
    let AgentToolCallInput {
        run_id,
        lease_generation,
        expected_version,
        tool_name,
        tool_version,
        normalized_args_hash,
        approval_nonce_hash,
        client_request_id,
    } = input;
    for (value, field, max) in [
        (&tool_name, "tool name", 200),
        (&tool_version, "tool version", 120),
        (&normalized_args_hash, "argument hash", 200),
    ] {
        validate_text(value, field, max)?;
    }
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    revision_matches(run.version, expected_version)?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if run.state != AgentRunState::Running {
        return Err("tool calls may only be requested from a running agent".into());
    }
    let policy_key = agent_tool_policy_key(run.installation_id, &tool_name, &tool_version);
    let policy = ctx
        .db
        .agent_tool_policy()
        .key()
        .find(policy_key.clone())
        .filter(|policy| policy.enabled)
        .ok_or_else(|| "agent tool is not registered or enabled".to_string())?;
    let trusted = ctx
        .db
        .trusted_tool()
        .key()
        .find(trusted_tool_key(&tool_name, &tool_version))
        .filter(|trusted| trusted.enabled)
        .ok_or_else(|| "tool is disabled or absent from the trusted catalog".to_string())?;
    if !crate::policy::trusted_tool_policy_current(
        trusted.enabled,
        trusted.revision,
        policy.trusted_tool_revision,
        trusted.capability == policy.capability,
        trusted.effect_class == policy.effect_class,
    ) {
        return Err("agent tool policy is stale relative to the trusted catalog".into());
    }
    if !agent_scope_enabled(ctx, run.installation_id, run.space_id, policy.capability) {
        return Err("agent tool capability denied".into());
    }
    if policy.requires_approval {
        validate_text(&approval_nonce_hash, "approval nonce hash", 200)?;
    }
    let input_hash = normalized_input_hash(&format!(
        "{run_id}\0{tool_name}\0{tool_version}\0{normalized_args_hash}\0{approval_nonce_hash}"
    ));
    if existing_receipt(
        ctx,
        Some(run.workspace_id),
        "request_agent_tool_call",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let effect_key =
        format!("agent-tool:{run_id}:{policy_key}:{client_request_id}:{normalized_args_hash}");
    let tool_call_id = new_id(ctx)?;
    ctx.db.agent_tool_call().insert(AgentToolCall {
        id: tool_call_id,
        run_id,
        tool_name,
        tool_version,
        policy_key,
        policy_revision: policy.revision,
        effect_class: policy.effect_class,
        normalized_args_hash: normalized_args_hash.clone(),
        effect_key: effect_key.clone(),
        requires_approval: policy.requires_approval,
        state: if policy.requires_approval {
            ToolCallState::AwaitingApproval
        } else {
            ToolCallState::Approved
        },
        result_summary: String::new(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.effect_ledger().insert(EffectLedger {
        effect_key: effect_key.clone(),
        tool_call_id,
        run_id,
        normalized_args_hash: normalized_args_hash.clone(),
        owner_identity: None,
        owner_generation: 0,
        state: EffectLedgerState::Pending,
        provider_reference: String::new(),
        result_summary: String::new(),
        updated_at: ctx.timestamp,
    });
    if policy.requires_approval {
        ctx.db.approval_request().insert(ApprovalRequest {
            id: new_id(ctx)?,
            run_id,
            tool_call_id,
            normalized_args_hash,
            effect_class: policy.effect_class,
            nonce_hash: approval_nonce_hash,
            state: ApprovalState::Pending,
            requested_by_service: ctx.sender(),
            decided_by: None,
            expires_at: ctx.timestamp
                + TimeDuration::from_micros(i64::from(policy.approval_ttl_seconds) * 1_000_000),
            created_at: ctx.timestamp,
            decided_at: None,
        });
        run.state = AgentRunState::AwaitingApproval;
    } else {
        run.state = AgentRunState::ExecutingTool;
    }
    let workspace_id = run.workspace_id;
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    insert_receipt(
        ctx,
        Some(workspace_id),
        "request_agent_tool_call",
        client_request_id,
        input_hash,
        "agent_tool_call",
        tool_call_id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn decide_tool_approval(
    ctx: &ReducerContext,
    approval_id: Uuid,
    normalized_args_hash: String,
    nonce_hash: String,
    approve: bool,
) -> Result<(), String> {
    require_registered_user(ctx)?;
    let mut approval = ctx
        .db
        .approval_request()
        .id()
        .find(approval_id)
        .ok_or_else(|| "approval request not found".to_string())?;
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(approval.run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    let caller_membership = find_membership(ctx, run.workspace_id, ctx.sender())
        .filter(|membership| membership.active)
        .ok_or_else(|| "current workspace membership required for approval".to_string())?;
    let can_approve = (run.initiated_by == ctx.sender()
        && ctx
            .db
            .space()
            .id()
            .find(run.space_id)
            .is_some_and(|space| can_read_space(ctx, &space, ctx.sender())))
        || role_allows(caller_membership.role, Action::ManageAgents);
    if !can_approve {
        return Err("approval permission denied".into());
    }
    let installation = ctx
        .db
        .agent_installation()
        .id()
        .find(run.installation_id)
        .ok_or_else(|| "agent installation not found".to_string())?;
    let initiating_membership = find_membership(ctx, run.workspace_id, run.initiated_by)
        .ok_or_else(|| "initiating membership not found".to_string())?;
    if !crate::policy::approval_decision_allowed(
        initiating_membership.active && caller_membership.active,
        run.state == AgentRunState::AwaitingApproval,
        is_terminal(run.state) || run.cancel_requested,
        installation.enabled
            && installation.authz_epoch == run.installation_epoch
            && initiating_membership.authz_epoch == run.membership_epoch,
        approval.state == ApprovalState::Pending && approval.expires_at > ctx.timestamp,
    ) {
        return Err("approval run authorization is stale".into());
    }
    if approval.state != ApprovalState::Pending {
        return Err("approval is no longer pending".into());
    }
    if approval.normalized_args_hash != normalized_args_hash || approval.nonce_hash != nonce_hash {
        return Err("approval binding mismatch".into());
    }
    let mut tool = ctx
        .db
        .agent_tool_call()
        .id()
        .find(approval.tool_call_id)
        .ok_or_else(|| "tool call not found".to_string())?;
    if tool.run_id != run.id || tool.state != ToolCallState::AwaitingApproval {
        return Err("approval tool state is stale".into());
    }
    if approval.expires_at <= ctx.timestamp {
        approval.state = ApprovalState::Expired;
        approval.decided_at = Some(ctx.timestamp);
        ctx.db.approval_request().id().update(approval);
        tool.state = ToolCallState::Canceled;
        tool.updated_at = ctx.timestamp;
        ctx.db.agent_tool_call().id().update(tool);
        run.state = AgentRunState::Failed;
        run.cancel_requested = true;
        run.lease_owner = None;
        run.lease_until = None;
        run.version = run.version.saturating_add(1);
        run.updated_at = ctx.timestamp;
        ctx.db.agent_run().id().update(run);
        return Ok(());
    }
    approval.state = if approve {
        ApprovalState::Approved
    } else {
        ApprovalState::Rejected
    };
    approval.decided_by = Some(ctx.sender());
    approval.decided_at = Some(ctx.timestamp);
    ctx.db.approval_request().id().update(approval);
    tool.state = if approve {
        ToolCallState::Approved
    } else {
        ToolCallState::Canceled
    };
    tool.updated_at = ctx.timestamp;
    ctx.db.agent_tool_call().id().update(tool);
    run.state = if approve {
        AgentRunState::ExecutingTool
    } else {
        AgentRunState::Canceled
    };
    run.cancel_requested = !approve;
    if !approve {
        run.lease_owner = None;
        run.lease_until = None;
    }
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn expire_tool_approval(ctx: &ReducerContext, approval_id: Uuid) -> Result<(), String> {
    let mut approval = ctx
        .db
        .approval_request()
        .id()
        .find(approval_id)
        .ok_or_else(|| "approval request not found".to_string())?;
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(approval.run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    if approval.state != ApprovalState::Pending || approval.expires_at > ctx.timestamp {
        return Err("approval is not expired and pending".into());
    }
    let mut tool = ctx
        .db
        .agent_tool_call()
        .id()
        .find(approval.tool_call_id)
        .ok_or_else(|| "tool call not found".to_string())?;
    approval.state = ApprovalState::Expired;
    approval.decided_at = Some(ctx.timestamp);
    tool.state = ToolCallState::Canceled;
    tool.updated_at = ctx.timestamp;
    run.state = AgentRunState::Failed;
    run.cancel_requested = true;
    run.lease_owner = None;
    run.lease_until = None;
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.approval_request().id().update(approval);
    ctx.db.agent_tool_call().id().update(tool);
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn acquire_agent_tool_effect(
    ctx: &ReducerContext,
    tool_call_id: Uuid,
    lease_generation: u64,
) -> Result<(), String> {
    let mut tool = ctx
        .db
        .agent_tool_call()
        .id()
        .find(tool_call_id)
        .ok_or_else(|| "tool call not found".to_string())?;
    let run = ctx
        .db
        .agent_run()
        .id()
        .find(tool.run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    let mut ledger = ctx
        .db
        .effect_ledger()
        .effect_key()
        .find(tool.effect_key.clone())
        .ok_or_else(|| "tool effect ledger not found".to_string())?;
    let mut approval = ctx.db.approval_request().tool_call_id().find(tool_call_id);
    let approval_valid = !tool.requires_approval
        || approval.as_ref().is_some_and(|row| {
            ((row.state == ApprovalState::Approved && row.expires_at > ctx.timestamp)
                || (row.state == ApprovalState::Consumed
                    && matches!(
                        ledger.state,
                        EffectLedgerState::Pending
                            | EffectLedgerState::Acquired
                            | EffectLedgerState::OutcomeUnknown
                    )))
                && row.normalized_args_hash == tool.normalized_args_hash
        });
    validate_agent_lease(
        ctx,
        &run,
        lease_generation,
        tool.requires_approval,
        approval_valid,
    )?;
    if run.state != AgentRunState::ExecutingTool {
        return Err("agent run is not executing a tool".into());
    }
    if matches!(
        ledger.state,
        EffectLedgerState::Succeeded | EffectLedgerState::Failed
    ) {
        return Ok(());
    }
    if !tool_execution_policy_current(ctx, &run, &tool) {
        let effect_may_have_occurred = ledger.state == EffectLedgerState::Acquired
            || matches!(
                tool.state,
                ToolCallState::Executing | ToolCallState::OutcomeUnknown
            );
        fence_stale_tool_execution(ctx, run, tool, ledger, effect_may_have_occurred);
        return Ok(());
    }
    if ledger.state == EffectLedgerState::Acquired {
        if ledger.owner_identity == Some(ctx.sender())
            && ledger.owner_generation == lease_generation
        {
            return Ok(());
        }
        ledger.state = EffectLedgerState::OutcomeUnknown;
        ledger.updated_at = ctx.timestamp;
        ctx.db.effect_ledger().effect_key().update(ledger);
        tool.state = ToolCallState::OutcomeUnknown;
        tool.updated_at = ctx.timestamp;
        ctx.db.agent_tool_call().id().update(tool);
        return Ok(());
    }
    if ledger.state == EffectLedgerState::OutcomeUnknown {
        return Err("tool effect must be reconciled before reacquisition".into());
    }
    if tool.state != ToolCallState::Approved {
        return Err("tool call is not approved for acquisition".into());
    }
    ledger.owner_identity = Some(ctx.sender());
    ledger.owner_generation = lease_generation;
    ledger.state = EffectLedgerState::Acquired;
    ledger.updated_at = ctx.timestamp;
    ctx.db.effect_ledger().effect_key().update(ledger);
    tool.state = ToolCallState::Executing;
    tool.updated_at = ctx.timestamp;
    ctx.db.agent_tool_call().id().update(tool);
    if let Some(mut approval) = approval.take() {
        approval.state = ApprovalState::Consumed;
        ctx.db.approval_request().id().update(approval);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn reconcile_agent_tool_effect(
    ctx: &ReducerContext,
    tool_call_id: Uuid,
    lease_generation: u64,
    provider_found: bool,
    provider_succeeded: bool,
    provider_reference: String,
    result_summary: String,
) -> Result<(), String> {
    if provider_reference.len() > 500 || result_summary.len() > 4_000 {
        return Err("tool reconciliation result exceeds limits".into());
    }
    let mut tool = ctx
        .db
        .agent_tool_call()
        .id()
        .find(tool_call_id)
        .ok_or_else(|| "tool call not found".to_string())?;
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(tool.run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    let mut ledger = ctx
        .db
        .effect_ledger()
        .effect_key()
        .find(tool.effect_key.clone())
        .ok_or_else(|| "tool effect ledger not found".to_string())?;
    if ledger.state != EffectLedgerState::OutcomeUnknown
        || tool.state != ToolCallState::OutcomeUnknown
    {
        return Err("tool effect is not awaiting reconciliation".into());
    }
    if !tool_execution_policy_current(ctx, &run, &tool) {
        fence_stale_tool_execution(ctx, run, tool, ledger, true);
        return Ok(());
    }
    if provider_found {
        ledger.state = if provider_succeeded {
            EffectLedgerState::Succeeded
        } else {
            EffectLedgerState::Failed
        };
        ledger.provider_reference = provider_reference;
        ledger.result_summary = result_summary.clone();
        tool.state = if provider_succeeded {
            ToolCallState::Succeeded
        } else {
            ToolCallState::Failed
        };
        tool.result_summary = result_summary;
        run.state = AgentRunState::Running;
    } else {
        ledger.state = EffectLedgerState::Pending;
        ledger.owner_identity = None;
        ledger.owner_generation = 0;
        tool.state = ToolCallState::Approved;
    }
    ledger.updated_at = ctx.timestamp;
    tool.updated_at = ctx.timestamp;
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.effect_ledger().effect_key().update(ledger);
    ctx.db.agent_tool_call().id().update(tool);
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn record_tool_outcome(
    ctx: &ReducerContext,
    tool_call_id: Uuid,
    lease_generation: u64,
    normalized_args_hash: String,
    outcome: ToolCallState,
    result_summary: String,
) -> Result<(), String> {
    validate_text(&result_summary, "tool result summary", 4_000)?;
    if !matches!(
        outcome,
        ToolCallState::Succeeded | ToolCallState::Failed | ToolCallState::OutcomeUnknown
    ) {
        return Err("invalid terminal tool outcome".into());
    }
    let mut tool = ctx
        .db
        .agent_tool_call()
        .id()
        .find(tool_call_id)
        .ok_or_else(|| "tool call not found".to_string())?;
    if tool.normalized_args_hash != normalized_args_hash {
        return Err("tool argument binding mismatch".into());
    }
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(tool.run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if run.state != AgentRunState::ExecutingTool || tool.state != ToolCallState::Executing {
        return Err("tool call is not executable".into());
    }
    let mut ledger = ctx
        .db
        .effect_ledger()
        .effect_key()
        .find(tool.effect_key.clone())
        .ok_or_else(|| "tool effect ledger not found".to_string())?;
    if !crate::policy::effect_commit_allowed(
        ledger.state == EffectLedgerState::Acquired,
        ledger.owner_identity == Some(ctx.sender()),
        ledger.owner_generation == lease_generation,
    ) {
        return Err("stale tool effect acquisition".into());
    }
    if !tool_execution_policy_current(ctx, &run, &tool) {
        fence_stale_tool_execution(ctx, run, tool, ledger, true);
        return Ok(());
    }
    tool.state = outcome;
    tool.result_summary = result_summary.clone();
    tool.updated_at = ctx.timestamp;
    ctx.db.agent_tool_call().id().update(tool);
    ledger.state = match outcome {
        ToolCallState::Succeeded => EffectLedgerState::Succeeded,
        ToolCallState::Failed => EffectLedgerState::Failed,
        ToolCallState::OutcomeUnknown => EffectLedgerState::OutcomeUnknown,
        _ => return Err("invalid terminal tool outcome".into()),
    };
    ledger.result_summary = result_summary;
    ledger.updated_at = ctx.timestamp;
    ctx.db.effect_ledger().effect_key().update(ledger);
    run.state = if outcome == ToolCallState::OutcomeUnknown {
        AgentRunState::ExecutingTool
    } else {
        AgentRunState::Running
    };
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn complete_agent_run(
    ctx: &ReducerContext,
    input: CompleteAgentRunInput,
) -> Result<(), String> {
    let CompleteAgentRunInput {
        run_id,
        lease_generation,
        expected_version,
        succeeded,
        output_summary,
        used_tokens,
        used_cost_micros,
    } = input;
    validate_text(&output_summary, "agent output summary", 50_000)?;
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    require_service(ctx, run.workspace_id, "agent")?;
    revision_matches(run.version, expected_version)?;
    let installation = validate_agent_lease(ctx, &run, lease_generation, false, true)?;
    if used_tokens > installation.max_run_tokens
        || used_cost_micros > installation.max_run_cost_micros
    {
        return Err("agent run exceeded configured budget".into());
    }
    let has_unfinished_work = ctx
        .db
        .agent_tool_call()
        .run_id()
        .filter(run_id)
        .any(|tool| {
            matches!(
                tool.state,
                ToolCallState::Proposed
                    | ToolCallState::AwaitingApproval
                    | ToolCallState::Approved
                    | ToolCallState::Executing
                    | ToolCallState::OutcomeUnknown
            )
        })
        || ctx
            .db
            .approval_request()
            .run_id()
            .filter(run_id)
            .any(|approval| {
                matches!(
                    approval.state,
                    ApprovalState::Pending | ApprovalState::Approved
                )
            });
    if !crate::policy::agent_completion_allowed(
        run.state == AgentRunState::Running && !is_terminal(run.state),
        has_unfinished_work,
    ) {
        return Err("agent run is not running or has unfinished/ambiguous tool work".into());
    }
    run.state = if succeeded {
        AgentRunState::Succeeded
    } else {
        AgentRunState::Failed
    };
    run.version = run.version.saturating_add(1);
    run.output_summary = output_summary.clone();
    run.used_tokens = used_tokens;
    run.used_cost_micros = used_cost_micros;
    run.lease_owner = None;
    run.lease_until = None;
    run.updated_at = ctx.timestamp;
    let sequence = run.next_event_sequence;
    run.next_event_sequence = run.next_event_sequence.saturating_add(1);
    ctx.db.agent_run_event().insert(AgentRunEvent {
        id: new_id(ctx)?,
        run_id,
        sequence,
        run_sequence_key: format!("{run_id}:{sequence}"),
        kind: if succeeded {
            "succeeded".into()
        } else {
            "failed".into()
        },
        summary: if succeeded {
            "Agent run completed".into()
        } else {
            "Agent run failed".into()
        },
        created_at: ctx.timestamp,
    });
    if succeeded
        && agent_scope_enabled(
            ctx,
            run.installation_id,
            run.space_id,
            AgentCapability::WriteContribution,
        )
        && let Some(thread_id) = run.thread_id
    {
        let contribution_id = new_id(ctx)?;
        insert_contribution_ancestry(ctx, contribution_id, thread_id, None)?;
        ctx.db.contribution().insert(Contribution {
            id: contribution_id,
            workspace_id: run.workspace_id,
            thread_id,
            author_identity: ctx.sender(),
            agent_installation_id: Some(run.installation_id),
            agent_run_id: Some(run.id),
            parent_contribution_id: None,
            kind: ContributionKind::AgentOutput,
            body: output_summary.clone(),
            revision: 1,
            deleted: false,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
        run.final_contribution_id = Some(contribution_id);
        let thread = ctx
            .db
            .named_thread()
            .id()
            .find(thread_id)
            .ok_or_else(|| "agent output thread not found".to_string())?;
        enqueue_search_snapshot(
            ctx,
            SearchSnapshotInput {
                workspace_id: run.workspace_id,
                space_id: run.space_id,
                resource_type: "contribution",
                resource_id: contribution_id,
                resource_revision: 1,
                title: &thread.title,
                body: &output_summary,
                tombstone: false,
            },
        )?;
    }
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn cancel_agent_run(
    ctx: &ReducerContext,
    run_id: Uuid,
    expected_version: u64,
) -> Result<(), String> {
    require_registered_user(ctx)?;
    let mut run = ctx
        .db
        .agent_run()
        .id()
        .find(run_id)
        .ok_or_else(|| "agent run not found".to_string())?;
    let allowed = run.initiated_by == ctx.sender()
        || find_membership(ctx, run.workspace_id, ctx.sender())
            .is_some_and(|member| member.active && role_allows(member.role, Action::ManageAgents));
    if !allowed {
        return Err("agent cancellation denied".into());
    }
    revision_matches(run.version, expected_version)?;
    if is_terminal(run.state) {
        return Ok(());
    }
    run.cancel_requested = true;
    run.state = AgentRunState::Canceled;
    cancel_open_agent_work(ctx, run.id);
    run.lease_owner = None;
    run.lease_until = None;
    run.version = run.version.saturating_add(1);
    run.updated_at = ctx.timestamp;
    ctx.db.agent_run().id().update(run);
    Ok(())
}

#[spacetimedb::reducer]
pub fn claim_outbox_job(
    ctx: &ReducerContext,
    job_id: Uuid,
    expected_generation: u64,
    lease_seconds: u32,
) -> Result<(), String> {
    if !(1..=300).contains(&lease_seconds) {
        return Err("outbox lease must be between 1 and 300 seconds".into());
    }
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "outbox job not found".to_string())?;
    require_service(ctx, job.workspace_id, &job.kind)?;
    if job.attempt >= OUTBOX_MAX_ATTEMPTS || job.expires_at <= ctx.timestamp {
        job.state = OutboxState::DeadLetter;
        job.last_error = "outbox_limits_exhausted".into();
        job.lease_owner = None;
        job.lease_until = None;
        job.updated_at = ctx.timestamp;
        ctx.db.outbox_job().id().update(job);
        return Ok(());
    }
    let expired_lease = job.state == OutboxState::Leased
        && job
            .lease_until
            .is_some_and(|expiry| expiry <= ctx.timestamp);
    if job.lease_generation != expected_generation
        || !(matches!(
            job.state,
            OutboxState::Pending | OutboxState::Retry | OutboxState::OutcomeUnknown
        ) || expired_lease)
        || (!expired_lease && job.next_attempt_at > ctx.timestamp)
    {
        return Err("outbox job is not claimable".into());
    }
    job.state = OutboxState::Leased;
    job.attempt = job.attempt.saturating_add(1);
    job.lease_owner = Some(ctx.sender());
    job.lease_until =
        Some(ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000));
    job.lease_generation = job.lease_generation.saturating_add(1);
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}

#[spacetimedb::reducer]
pub fn heartbeat_outbox_job(
    ctx: &ReducerContext,
    job_id: Uuid,
    lease_generation: u64,
    lease_seconds: u32,
) -> Result<(), String> {
    if !(1..=300).contains(&lease_seconds) {
        return Err("outbox lease must be between 1 and 300 seconds".into());
    }
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "outbox job not found".to_string())?;
    require_service(ctx, job.workspace_id, &job.kind)?;
    if job.state != OutboxState::Leased
        || job.lease_owner != Some(ctx.sender())
        || job.lease_generation != lease_generation
        || job.lease_until.is_none_or(|expiry| expiry <= ctx.timestamp)
    {
        return Err("stale or expired outbox lease".into());
    }
    job.lease_until =
        Some(ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000));
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}

#[spacetimedb::reducer]
pub fn complete_outbox_job(
    ctx: &ReducerContext,
    job_id: Uuid,
    lease_generation: u64,
    outcome: OutboxState,
    last_error: String,
    retry_after_seconds: u32,
) -> Result<(), String> {
    if !matches!(
        outcome,
        OutboxState::Succeeded
            | OutboxState::Retry
            | OutboxState::OutcomeUnknown
            | OutboxState::DeadLetter
    ) {
        return Err("invalid outbox completion state".into());
    }
    if last_error.len() > 2_000 {
        return Err("outbox error summary exceeds 2000 bytes".into());
    }
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "outbox job not found".to_string())?;
    require_service(ctx, job.workspace_id, &job.kind)?;
    if job.state != OutboxState::Leased
        || job.lease_owner != Some(ctx.sender())
        || job.lease_generation != lease_generation
        || job.lease_until.is_none_or(|expiry| expiry <= ctx.timestamp)
    {
        return Err("stale or expired outbox lease".into());
    }
    job.state = outcome;
    job.last_error = last_error;
    job.next_attempt_at = ctx.timestamp
        + TimeDuration::from_micros(i64::from(retry_after_seconds.min(86_400)) * 1_000_000);
    job.lease_owner = None;
    job.lease_until = None;
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}
