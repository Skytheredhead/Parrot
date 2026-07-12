use crate::authz::*;
use crate::model::*;
use spacetimedb::{DbContext, Identity, ReducerContext, Table, TimeDuration, Uuid};

const POLICY_VERSION: u32 = 1;
const OUTBOX_MAX_ATTEMPTS: u32 = 12;
const OUTBOX_MAX_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_REPLY_DEPTH: u32 = 32;
const MAX_PRESENCE_SESSIONS_PER_SCOPE: usize = 8;
const WORKSPACE_LIFECYCLE_DRAIN_BATCH: usize = 64;
const MAX_ACTIVE_LEGAL_HOLDS_PER_WORKSPACE: usize = 16;
const MAX_ACTIVE_EXPORTS_PER_WORKSPACE: usize = 3;
const NOTIFICATION_GROUP_WINDOW_SECONDS: i64 = 5 * 60;
const NOTIFICATION_PERMIT_MAX_SECONDS: u32 = 5;
const NOTIFICATION_DIGEST_MAX_CLAIMS: usize = 32;
const NOTIFICATION_DIGEST_MAX_ITEMS: usize = 50;
const NOTIFICATION_DIGEST_MAX_LEASE_SECONDS: u32 = 300;
const JOB_NOTIFICATION_DELIVER: &str =
    crate::policy::CanonicalJobKind::NotificationDeliver.as_str();
const JOB_SEARCH_UPSERT: &str = crate::policy::CanonicalJobKind::SearchUpsert.as_str();
const JOB_SEARCH_TOMBSTONE: &str = crate::policy::CanonicalJobKind::SearchTombstone.as_str();
const JOB_SEARCH_REBUILD: &str = crate::policy::CanonicalJobKind::SearchRebuild.as_str();
const JOB_FILE_SCAN: &str = crate::policy::CanonicalJobKind::FileScan.as_str();
const JOB_FILE_EXTRACT: &str = crate::policy::CanonicalJobKind::FileExtract.as_str();
const JOB_FILE_CLEANUP: &str = crate::policy::CanonicalJobKind::FileCleanup.as_str();
const JOB_AGENT_RUN: &str = crate::policy::CanonicalJobKind::AgentRun.as_str();
const JOB_WORKSPACE_EXPORT_GENERATE: &str =
    crate::policy::CanonicalJobKind::WorkspaceExportGenerate.as_str();
const JOB_WORKSPACE_EXPORT_CLEANUP: &str =
    crate::policy::CanonicalJobKind::WorkspaceExportCleanup.as_str();
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

fn new_workspace_lifecycle(workspace_id: Uuid, now: spacetimedb::Timestamp) -> WorkspaceLifecycle {
    WorkspaceLifecycle {
        workspace_id,
        state: WorkspaceLifecycleState::Active,
        lifecycle_epoch: 1,
        deleted_content_retention_days: None,
        deletion_grace_days: None,
        deletion_requested_by: None,
        deletion_requested_at: None,
        deletion_execute_after: None,
        revision: 1,
        created_at: now,
        updated_at: now,
    }
}

fn policy_workspace_lifecycle_state(
    state: WorkspaceLifecycleState,
) -> crate::policy::PolicyWorkspaceLifecycleState {
    match state {
        WorkspaceLifecycleState::Active => crate::policy::PolicyWorkspaceLifecycleState::Active,
        WorkspaceLifecycleState::DeletionRequested => {
            crate::policy::PolicyWorkspaceLifecycleState::DeletionRequested
        }
        WorkspaceLifecycleState::DeletionFenced => {
            crate::policy::PolicyWorkspaceLifecycleState::DeletionFenced
        }
    }
}

fn workspace_lifecycle_row_valid(row: &WorkspaceLifecycle) -> bool {
    let request_fields = (
        row.deletion_requested_by.is_some(),
        row.deletion_requested_at,
        row.deletion_execute_after,
    );
    row.lifecycle_epoch > 0
        && row.revision > 0
        && crate::policy::workspace_lifecycle_configuration_valid(
            row.deleted_content_retention_days,
            row.deletion_grace_days,
        )
        && match row.state {
            WorkspaceLifecycleState::Active => request_fields == (false, None, None),
            WorkspaceLifecycleState::DeletionRequested
            | WorkspaceLifecycleState::DeletionFenced => {
                row.deletion_grace_days.is_some()
                    && request_fields.0
                    && request_fields
                        .1
                        .zip(request_fields.2)
                        .is_some_and(|(requested, execute_after)| execute_after > requested)
            }
        }
}

fn workspace_has_active_legal_hold(ctx: &ReducerContext, workspace_id: Uuid) -> bool {
    ctx.db
        .workspace_legal_hold()
        .workspace_state()
        .filter((workspace_id, WorkspaceLegalHoldState::Active))
        .next()
        .is_some()
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

fn require_export_generation_completion_service(
    ctx: &ReducerContext,
    workspace_id: Uuid,
) -> Result<ServicePrincipal, String> {
    require_oidc(ctx)?;
    let service = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .filter(|service| service.enabled && service.can_process_outbox)
        .ok_or_else(|| "service capability denied".to_string())?;
    if !service_has_grant(
        ctx,
        ctx.sender(),
        workspace_id,
        JOB_WORKSPACE_EXPORT_GENERATE,
    ) {
        return Err("service capability denied".into());
    }
    Ok(service)
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
        || ctx.db.workspace_lifecycle().count() != 0
        || ctx.db.workspace_lifecycle_drain_schedule().count() != 0
        || ctx.db.workspace_legal_hold().count() != 0
        || ctx.db.workspace_export().count() != 0
        || ctx.db.workspace_export_expiry_schedule().count() != 0
        || ctx.db.workspace_member().count() != 0
        || ctx.db.space().count() != 0
        || ctx.db.space_member().count() != 0
        || ctx.db.post().count() != 0
        || ctx.db.post_tag().count() != 0
        || ctx.db.post_mention().count() != 0
        || ctx.db.post_reaction().count() != 0
        || ctx.db.post_user_state().count() != 0
        || ctx.db.post_pin().count() != 0
        || ctx.db.post_activity().count() != 0
        || ctx.db.poll().count() != 0
        || ctx.db.poll_option().count() != 0
        || ctx.db.poll_vote().count() != 0
        || ctx.db.named_thread().count() != 0
        || ctx.db.contribution().count() != 0
        || ctx.db.reply_ancestry().count() != 0
        || ctx.db.direct_conversation().count() != 0
        || ctx.db.direct_participant().count() != 0
        || ctx.db.direct_message().count() != 0
        || ctx.db.direct_reply_ancestry().count() != 0
        || ctx.db.direct_read_state().count() != 0
        || ctx.db.dm_promotion_proposal().count() != 0
        || ctx.db.dm_promotion_source().count() != 0
        || ctx.db.dm_promotion_consent().count() != 0
        || ctx.db.decision_record().count() != 0
        || ctx.db.task_item().count() != 0
        || ctx.db.notification().count() != 0
        || ctx.db.notification_control().count() != 0
        || ctx.db.notification_group().count() != 0
        || ctx.db.notification_delivery_permit().count() != 0
        || ctx.db.notification_preference().count() != 0
        || ctx.db.notification_digest_schedule().count() != 0
        || ctx.db.notification_digest_item().count() != 0
        || ctx.db.notification_digest_claim().count() != 0
        || ctx.db.notification_digest_permit().count() != 0
        || ctx.db.notification_digest_outcome().count() != 0
        || ctx.db.presence_session().count() != 0
        || ctx.db.current_presence().count() != 0
        || ctx.db.presence_expiry_schedule().count() != 0
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

fn private_receipt_disposition(
    ctx: &ReducerContext,
    operation: &str,
    request_id: Uuid,
    input_hash: &str,
) -> Result<crate::policy::PrivateReplayDisposition, String> {
    require_registered_user(ctx)?;
    let receipt =
        ctx.db
            .command_receipt()
            .key()
            .find(receipt_key(ctx.sender(), None, operation, request_id));
    Ok(crate::policy::private_replay_disposition(
        receipt.as_ref().map(|row| row.input_hash.as_str()),
        input_hash,
    ))
}

fn existing_private_receipt(
    ctx: &ReducerContext,
    operation: &str,
    request_id: Uuid,
    input_hash: &str,
    unavailable_error: &str,
) -> Result<bool, String> {
    match private_receipt_disposition(ctx, operation, request_id, input_hash)? {
        crate::policy::PrivateReplayDisposition::NoReceipt => Ok(false),
        crate::policy::PrivateReplayDisposition::Exact => Ok(true),
        crate::policy::PrivateReplayDisposition::Conflict => Err(unavailable_error.into()),
    }
}

fn existing_direct_message_receipt(
    ctx: &ReducerContext,
    operation: crate::policy::PrivateDirectMessageOperation,
    request_id: Uuid,
    input_hash: &str,
) -> Result<bool, String> {
    crate::policy::direct_message_replay_gate(
        operation,
        private_receipt_disposition(ctx, operation.as_str(), request_id, input_hash)?,
    )
    .map_err(str::to_string)
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

fn insert_private_receipt(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    operation: &str,
    request_id: Uuid,
    input_hash: String,
    result_type: &str,
    result_id: Uuid,
) {
    ctx.db.command_receipt().insert(CommandReceipt {
        key: receipt_key(ctx.sender(), None, operation, request_id),
        actor_identity: derived_actor(ctx.sender(), ctx.sender()),
        workspace_id: Some(workspace_id),
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

#[derive(Default)]
struct OutboxSemanticPayload {
    intent_id: Option<Uuid>,
    recipient_id: Option<Identity>,
    channel: String,
    authorization_epoch: Option<u64>,
    minimal_message: String,
    payload_resource_id: Option<Uuid>,
    rebuild_id: Option<Uuid>,
    generation: Option<u64>,
    file_id: Option<Uuid>,
    version: Option<u64>,
    acl_revision: Option<u64>,
    run_id: Option<Uuid>,
}

impl OutboxSemanticPayload {
    fn valid_for(&self, kind: &str) -> bool {
        if crate::policy::CanonicalJobKind::parse(kind).is_none() {
            return false;
        }
        match kind {
            JOB_NOTIFICATION_DELIVER => {
                self.intent_id.is_some()
                    && self.recipient_id.is_some()
                    && matches!(self.channel.as_str(), "email" | "push")
                    && self.authorization_epoch.is_some()
                    && !self.minimal_message.is_empty()
                    && self.payload_resource_id.is_some()
                    && self.version.is_some()
            }
            JOB_SEARCH_UPSERT | JOB_SEARCH_TOMBSTONE => {
                self.payload_resource_id.is_some()
                    && self.version.is_some()
                    && self.acl_revision.is_some()
            }
            JOB_SEARCH_REBUILD => self.rebuild_id.is_some() && self.generation.is_some(),
            JOB_FILE_SCAN | JOB_FILE_EXTRACT | JOB_FILE_CLEANUP => {
                self.file_id.is_some() && self.version.is_some()
            }
            JOB_AGENT_RUN => self.run_id.is_some(),
            JOB_WORKSPACE_EXPORT_GENERATE | JOB_WORKSPACE_EXPORT_CLEANUP => {
                self.payload_resource_id.is_some() && self.version.is_some()
            }
            _ => false,
        }
    }
}

struct OutboxInsert<'a> {
    workspace_id: Uuid,
    kind: &'a str,
    resource_type: &'a str,
    resource_id: Uuid,
    resource_revision: u64,
    effect_key: String,
    payload: OutboxSemanticPayload,
}

fn enqueue_outbox(ctx: &ReducerContext, input: OutboxInsert<'_>) -> Result<(), String> {
    let OutboxInsert {
        workspace_id,
        kind,
        resource_type,
        resource_id,
        resource_revision,
        effect_key,
        payload,
    } = input;
    let common_fields_match = match kind {
        JOB_NOTIFICATION_DELIVER => {
            payload.intent_id == Some(resource_id) && payload.version == Some(resource_revision)
        }
        JOB_SEARCH_UPSERT | JOB_SEARCH_TOMBSTONE => {
            payload.payload_resource_id == Some(resource_id)
                && payload.version == Some(resource_revision)
        }
        JOB_SEARCH_REBUILD => {
            payload.rebuild_id == Some(resource_id) && payload.generation == Some(resource_revision)
        }
        JOB_FILE_SCAN | JOB_FILE_EXTRACT | JOB_FILE_CLEANUP => {
            payload.file_id == Some(resource_id) && payload.version == Some(resource_revision)
        }
        JOB_AGENT_RUN => crate::policy::agent_run_job_contract_valid(
            kind,
            resource_type == "agent_run",
            payload.run_id == Some(resource_id),
        ),
        JOB_WORKSPACE_EXPORT_GENERATE | JOB_WORKSPACE_EXPORT_CLEANUP => {
            resource_type == "workspace_export"
                && payload.payload_resource_id == Some(resource_id)
                && payload.version == Some(resource_revision)
        }
        _ => false,
    };
    if !payload.valid_for(kind) || !common_fields_match {
        return Err("outbox job kind or semantic payload is invalid".into());
    }
    ctx.db.outbox_job().insert(OutboxJob {
        id: new_id(ctx)?,
        workspace_id,
        effect_key: effect_key.clone(),
        state: OutboxState::Pending,
        kind: kind.into(),
        resource_type: resource_type.into(),
        resource_id,
        resource_revision,
        acl_revision: payload.acl_revision,
        intent_id: payload.intent_id,
        recipient_id: payload.recipient_id,
        channel: payload.channel,
        authorization_epoch: payload.authorization_epoch,
        minimal_message: payload.minimal_message,
        payload_resource_id: payload.payload_resource_id,
        rebuild_id: payload.rebuild_id,
        generation: payload.generation,
        file_id: payload.file_id,
        version: payload.version,
        run_id: payload.run_id,
        expires_at: ctx.timestamp + TimeDuration::from_micros(OUTBOX_MAX_AGE_SECONDS * 1_000_000),
        attempt: 0,
        lease_owner: None,
        worker_slot_id: String::new(),
        lease_until: None,
        lease_generation: 0,
        next_attempt_at: ctx.timestamp,
        last_error: String::new(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

fn require_workspace_export_cleanup(
    ctx: &ReducerContext,
    mut export: WorkspaceExport,
) -> Result<WorkspaceExport, String> {
    if export.state == WorkspaceExportState::Ready {
        export.state = WorkspaceExportState::Expired;
        export.revision = export
            .revision
            .checked_add(1)
            .ok_or_else(|| "workspace export revision exhausted".to_string())?;
        export.expires_at.get_or_insert(ctx.timestamp);
        export.failure_reason.clear();
        export.updated_at = ctx.timestamp;
        ctx.db.workspace_export().id().update(export.clone());
    }
    if export.state != WorkspaceExportState::Expired
        || !crate::policy::workspace_export_artifact_key_valid(
            &export.workspace_id.to_string(),
            &export.id.to_string(),
            &export.artifact_key,
        )
        || export.content_hash.len() != 64
        || !export
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !crate::policy::workspace_export_artifact_version_valid(&export.artifact_version)
        || !crate::policy::workspace_export_size_valid(export.size_bytes)
    {
        return Err("workspace export cleanup authority is invalid".into());
    }
    let effect_key = format!(
        "workspace:{}:export:{}:cleanup:{}",
        export.workspace_id, export.id, export.revision
    );
    if ctx
        .db
        .outbox_job()
        .effect_key()
        .find(effect_key.clone())
        .is_none()
    {
        enqueue_outbox(
            ctx,
            OutboxInsert {
                workspace_id: export.workspace_id,
                kind: JOB_WORKSPACE_EXPORT_CLEANUP,
                resource_type: "workspace_export",
                resource_id: export.id,
                resource_revision: export.revision,
                effect_key,
                payload: OutboxSemanticPayload {
                    payload_resource_id: Some(export.id),
                    version: Some(export.revision),
                    ..Default::default()
                },
            },
        )?;
    }
    Ok(export)
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
    let (acl_revision, resource_revision) =
        crate::policy::search_snapshot_order_key(space.revision, input.resource_revision);
    let effect_key = format!(
        "search:{}:{}:acl:{}:revision:{}:{}",
        input.resource_type,
        input.resource_id,
        acl_revision,
        resource_revision,
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
            resource_revision,
            acl_revision,
            title: input.title.into(),
            body: input.body.into(),
            tombstone: input.tombstone,
            allowed_identities: search_allowed_identities(ctx, &space),
            created_at: ctx.timestamp,
        });
    enqueue_outbox(
        ctx,
        OutboxInsert {
            workspace_id: input.workspace_id,
            kind: if input.tombstone {
                JOB_SEARCH_TOMBSTONE
            } else {
                JOB_SEARCH_UPSERT
            },
            resource_type: input.resource_type,
            resource_id: input.resource_id,
            resource_revision,
            effect_key,
            payload: OutboxSemanticPayload {
                payload_resource_id: Some(input.resource_id),
                version: Some(resource_revision),
                acl_revision: Some(acl_revision),
                ..Default::default()
            },
        },
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

fn presence_session_key(workspace_id: Uuid, identity: Identity, session_id: Uuid) -> String {
    format!("{workspace_id}:{identity}:{session_id}")
}

fn presence_scope_key(workspace_id: Uuid, identity: Identity) -> String {
    format!("{workspace_id}:{identity}")
}

fn remove_presence_session(ctx: &ReducerContext, presence_key: &str) {
    ctx.db
        .presence_session()
        .key()
        .delete(presence_key.to_string());
    ctx.db
        .presence_expiry_schedule()
        .presence_key()
        .delete(presence_key.to_string());
}

fn refresh_current_presence(ctx: &ReducerContext, workspace_id: Uuid, identity: Identity) {
    let scope_key = presence_scope_key(workspace_id, identity);
    let latest = ctx
        .db
        .presence_session()
        .scope_key()
        .filter(&scope_key)
        .filter(|session| session.expires_at > ctx.timestamp)
        .max_by_key(|session| session.expires_at);
    if let Some(session) = latest {
        let row = CurrentPresence {
            key: scope_key.clone(),
            workspace_id,
            identity,
            status: session.status,
            expires_at: session.expires_at,
            updated_at: ctx.timestamp,
        };
        if ctx.db.current_presence().key().find(scope_key).is_some() {
            ctx.db.current_presence().key().update(row);
        } else {
            ctx.db.current_presence().insert(row);
        }
    } else {
        ctx.db.current_presence().key().delete(scope_key);
    }
}

fn notification_preference_key(
    workspace_id: Uuid,
    space_id: Option<Uuid>,
    identity: Identity,
) -> String {
    format!(
        "{workspace_id}:{identity}:{}",
        space_id.map_or_else(|| "workspace".into(), |id| id.to_string())
    )
}

fn notification_coalesce_key(
    workspace_id: Uuid,
    recipient_identity: Identity,
    kind: NotificationKind,
    resource_type: &str,
    resource_id: Uuid,
) -> String {
    format!("{workspace_id}:{recipient_identity}:{kind:?}:{resource_type}:{resource_id}")
}

fn notification_tier(kind: NotificationKind) -> NotificationTier {
    match kind {
        NotificationKind::Mention | NotificationKind::Assignment => NotificationTier::Direct,
        NotificationKind::Decision | NotificationKind::Agent => NotificationTier::Important,
        NotificationKind::System => NotificationTier::Ambient,
    }
}

pub(crate) struct ResolvedNotificationPreference {
    pub(crate) mode: NotificationDeliveryMode,
    pub(crate) mute_window_configured: bool,
    pub(crate) revision: u64,
    pub(crate) key: String,
    pub(crate) time_zone: String,
    pub(crate) digest_local_minute: u16,
}

pub(crate) fn notification_mode<C: DbContext>(
    ctx: &C,
    workspace_id: Uuid,
    space_id: Option<Uuid>,
    identity: Identity,
    tier: NotificationTier,
) -> ResolvedNotificationPreference {
    let default_key = notification_preference_key(workspace_id, None, identity);
    let preference =
        space_id
            .and_then(|space_id| {
                ctx.db_read_only().notification_preference().key().find(
                    notification_preference_key(workspace_id, Some(space_id), identity),
                )
            })
            .or_else(|| {
                ctx.db_read_only()
                    .notification_preference()
                    .key()
                    .find(notification_preference_key(workspace_id, None, identity))
            });
    let default = match tier {
        NotificationTier::Direct | NotificationTier::Important => {
            NotificationDeliveryMode::Immediate
        }
        NotificationTier::Ambient => NotificationDeliveryMode::Digest,
    };
    preference.map_or(
        ResolvedNotificationPreference {
            mode: default,
            mute_window_configured: false,
            revision: 0,
            key: default_key,
            time_zone: "UTC".into(),
            digest_local_minute: 540,
        },
        |preference| {
            let mode = match tier {
                NotificationTier::Direct => preference.direct_mode,
                NotificationTier::Important => preference.important_mode,
                NotificationTier::Ambient => preference.ambient_mode,
            };
            ResolvedNotificationPreference {
                mode,
                mute_window_configured: preference.mute_start_local_minute.is_some(),
                revision: preference.revision,
                key: preference.key,
                time_zone: preference.time_zone,
                digest_local_minute: preference.digest_local_minute,
            }
        },
    )
}

fn notification_digest_schedule_key(
    workspace_id: Uuid,
    recipient_identity: Identity,
    preference_key: &str,
    channel: &str,
) -> String {
    format!("{workspace_id}:{recipient_identity}:{preference_key}:{channel}")
}

fn register_notification_digest(
    ctx: &ReducerContext,
    notification_id: Uuid,
    workspace_id: Uuid,
    recipient_identity: Identity,
    channel: &str,
    preference: &ResolvedNotificationPreference,
) -> Result<(), String> {
    let key = notification_digest_schedule_key(
        workspace_id,
        recipient_identity,
        &preference.key,
        channel,
    );
    let mut schedule = if let Some(mut schedule) = ctx
        .db
        .notification_digest_schedule()
        .key()
        .find(key.clone())
    {
        schedule.preference_key = preference.key.clone();
        schedule.time_zone = preference.time_zone.clone();
        schedule.digest_local_minute = preference.digest_local_minute;
        schedule.preference_revision = preference.revision;
        schedule.digest_revision = schedule
            .digest_revision
            .checked_add(1)
            .ok_or_else(|| "notification digest revision exhausted".to_string())?;
        schedule.updated_at = ctx.timestamp;
        schedule
    } else {
        NotificationDigestSchedule {
            id: new_id(ctx)?,
            key,
            workspace_id,
            recipient_identity,
            preference_key: preference.key.clone(),
            channel: channel.into(),
            time_zone: preference.time_zone.clone(),
            digest_local_minute: preference.digest_local_minute,
            preference_revision: preference.revision,
            digest_revision: 1,
            overflow_count: 0,
            overflow_revision: 0,
            last_occurrence_local_date: String::new(),
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        }
    };
    let digest_revision = schedule.digest_revision;
    let schedule_id = schedule.id;
    let existing_item = ctx
        .db
        .notification_digest_item()
        .notification_id()
        .find(notification_id);
    if let Some(mut item) = existing_item {
        item.schedule_id = schedule_id;
        item.digest_revision = digest_revision;
        item.updated_at = ctx.timestamp;
        ctx.db
            .notification_digest_item()
            .notification_id()
            .update(item);
    } else {
        let pending_count = ctx
            .db
            .notification_digest_item()
            .schedule_id()
            .filter(schedule_id)
            .take(NOTIFICATION_DIGEST_MAX_ITEMS)
            .count();
        if pending_count < NOTIFICATION_DIGEST_MAX_ITEMS {
            ctx.db
                .notification_digest_item()
                .insert(NotificationDigestItem {
                    notification_id,
                    schedule_id,
                    digest_revision,
                    created_at: ctx.timestamp,
                    updated_at: ctx.timestamp,
                });
        } else {
            schedule.overflow_count = schedule.overflow_count.saturating_add(1);
            schedule.overflow_revision = digest_revision;
        }
    }
    if ctx
        .db
        .notification_digest_schedule()
        .id()
        .find(schedule_id)
        .is_some()
    {
        ctx.db.notification_digest_schedule().id().update(schedule);
    } else {
        ctx.db.notification_digest_schedule().insert(schedule);
    }
    Ok(())
}

fn refresh_notification_digest_schedule_preference(
    ctx: &ReducerContext,
    preference: &NotificationPreference,
) -> Result<(), String> {
    for channel in ["email", "push"] {
        let schedule_key = notification_digest_schedule_key(
            preference.workspace_id,
            preference.identity,
            &preference.key,
            channel,
        );
        let Some(mut schedule) = ctx
            .db
            .notification_digest_schedule()
            .key()
            .find(schedule_key)
        else {
            continue;
        };
        if schedule.preference_revision == preference.revision
            && schedule.time_zone == preference.time_zone
            && schedule.digest_local_minute == preference.digest_local_minute
        {
            continue;
        }
        schedule.preference_revision = preference.revision;
        schedule.time_zone = preference.time_zone.clone();
        schedule.digest_local_minute = preference.digest_local_minute;
        schedule.digest_revision = schedule
            .digest_revision
            .checked_add(1)
            .ok_or_else(|| "notification digest revision exhausted".to_string())?;
        schedule.updated_at = ctx.timestamp;
        ctx.db.notification_digest_schedule().id().update(schedule);
    }
    Ok(())
}

pub(crate) fn notification_resource_revision<C: DbContext>(
    ctx: &C,
    workspace_id: Uuid,
    resource_type: &str,
    resource_id: Uuid,
) -> Option<u64> {
    match resource_type {
        "post" => ctx
            .db_read_only()
            .post()
            .id()
            .find(resource_id)
            .filter(|post| post.workspace_id == workspace_id && !post.deleted)
            .map(|post| post.revision),
        "task" => ctx
            .db_read_only()
            .task_item()
            .id()
            .find(resource_id)
            .filter(|task| task.workspace_id == workspace_id)
            .map(|task| task.revision),
        _ => None,
    }
}

pub(crate) fn notification_resource_visible_to<C: DbContext>(
    ctx: &C,
    workspace_id: Uuid,
    identity: Identity,
    resource_type: &str,
    resource_id: Uuid,
) -> bool {
    if !can_read_workspace(ctx, workspace_id, identity) {
        return false;
    }
    match resource_type {
        "post" => ctx
            .db_read_only()
            .post()
            .id()
            .find(resource_id)
            .is_some_and(|post| {
                post.workspace_id == workspace_id
                    && !post.deleted
                    && ctx
                        .db_read_only()
                        .space()
                        .id()
                        .find(post.space_id)
                        .is_some_and(|space| can_read_space(ctx, &space, identity))
            }),
        "task" => ctx
            .db_read_only()
            .task_item()
            .id()
            .find(resource_id)
            .is_some_and(|task| {
                task.workspace_id == workspace_id
                    && task.thread_id.is_none_or(|thread_id| {
                        ctx.db_read_only()
                            .named_thread()
                            .id()
                            .find(thread_id)
                            .and_then(|thread| {
                                ctx.db_read_only().space().id().find(thread.space_id)
                            })
                            .is_some_and(|space| can_read_space(ctx, &space, identity))
                    })
            }),
        _ => false,
    }
}

pub(crate) struct NotificationAuthoritySnapshot {
    pub(crate) delivery_state: NotificationDeliveryState,
    pub(crate) suppression_reason: String,
    pub(crate) membership_epoch: u64,
    pub(crate) preference_revision: u64,
    pub(crate) resource_revision: u64,
}

pub(crate) fn notification_authority_snapshot<C: DbContext>(
    ctx: &C,
    notification: &Notification,
    control: &NotificationControl,
) -> NotificationAuthoritySnapshot {
    let membership = find_membership(ctx, control.workspace_id, control.recipient_identity)
        .filter(|membership| membership.active);
    let preference = notification_mode(
        ctx,
        control.workspace_id,
        control.space_id,
        control.recipient_identity,
        control.tier,
    );
    let resource_revision = notification_resource_revision(
        ctx,
        control.workspace_id,
        &control.resource_type,
        control.resource_id,
    )
    .unwrap_or(0);
    let binding_current = notification.id == control.notification_id
        && notification.workspace_id == control.workspace_id
        && notification.recipient_identity == control.recipient_identity
        && notification.kind == control.event_class
        && notification.resource_type == control.resource_type
        && notification.resource_id == control.resource_id;
    let permission_current = notification_resource_visible_to(
        ctx,
        control.workspace_id,
        control.recipient_identity,
        &control.resource_type,
        control.resource_id,
    );
    let membership_epoch = membership
        .as_ref()
        .map_or(0, |membership| membership.authz_epoch);
    let current = binding_current
        && permission_current
        && membership_epoch == control.membership_epoch
        && resource_revision == control.resource_revision
        && preference.revision == control.preference_revision
        && preference.mode == NotificationDeliveryMode::Immediate
        && !preference.mute_window_configured;
    let suppression_reason = if !binding_current {
        "authority_binding_stale"
    } else if membership.is_none() || !permission_current {
        "permission_revoked"
    } else if membership_epoch != control.membership_epoch {
        "membership_epoch_stale"
    } else if resource_revision != control.resource_revision {
        "resource_revision_stale"
    } else if preference.revision != control.preference_revision {
        "preference_revision_stale"
    } else if preference.mute_window_configured {
        "mute_window"
    } else {
        match preference.mode {
            NotificationDeliveryMode::Immediate => "",
            NotificationDeliveryMode::Digest => "digest",
            NotificationDeliveryMode::Disabled => "disabled",
        }
    };
    NotificationAuthoritySnapshot {
        delivery_state: if current {
            NotificationDeliveryState::Pending
        } else {
            NotificationDeliveryState::Suppressed
        },
        suppression_reason: suppression_reason.into(),
        membership_epoch,
        preference_revision: preference.revision,
        resource_revision,
    }
}

struct NotificationIntent<'a> {
    workspace_id: Uuid,
    space_id: Option<Uuid>,
    recipient_identity: Identity,
    kind: NotificationKind,
    resource_type: &'a str,
    resource_id: Uuid,
    summary: &'a str,
}

fn coalesce_notification(
    ctx: &ReducerContext,
    intent: NotificationIntent<'_>,
) -> Result<Option<Uuid>, String> {
    if !notification_resource_visible_to(
        ctx,
        intent.workspace_id,
        intent.recipient_identity,
        intent.resource_type,
        intent.resource_id,
    ) {
        return Ok(None);
    }
    let tier = notification_tier(intent.kind);
    let base_key = notification_coalesce_key(
        intent.workspace_id,
        intent.recipient_identity,
        intent.kind,
        intent.resource_type,
        intent.resource_id,
    );
    let resource_revision = notification_resource_revision(
        ctx,
        intent.workspace_id,
        intent.resource_type,
        intent.resource_id,
    )
    .ok_or_else(|| "notification resource revision unavailable".to_string())?;
    let membership = find_membership(ctx, intent.workspace_id, intent.recipient_identity)
        .filter(|membership| membership.active)
        .ok_or_else(|| "notification recipient membership unavailable".to_string())?;
    let preference = notification_mode(
        ctx,
        intent.workspace_id,
        intent.space_id,
        intent.recipient_identity,
        tier,
    );
    let existing_group = ctx
        .db
        .notification_group()
        .base_key()
        .find(base_key.clone());
    let same_window = crate::policy::notification_group_window_reusable(
        existing_group
            .as_ref()
            .is_some_and(|group| group.window_expires_at > ctx.timestamp),
    );
    let (notification_id, group_key, group_revision, window_started_at, window_expires_at) =
        if same_window {
            let mut group = existing_group.expect("same-window group must exist");
            group.group_revision = group
                .group_revision
                .checked_add(1)
                .ok_or_else(|| "notification group revision exhausted".to_string())?;
            group.updated_at = ctx.timestamp;
            let mut notification = ctx
                .db
                .notification()
                .id()
                .find(group.notification_id)
                .ok_or_else(|| "notification group row unavailable".to_string())?;
            if !crate::policy::notification_coalesce_binding_valid(
                notification.recipient_identity == intent.recipient_identity,
                notification.workspace_id == intent.workspace_id,
                notification.resource_type == intent.resource_type
                    && notification.resource_id == intent.resource_id,
                notification.kind == intent.kind,
            ) {
                return Err("notification coalescing authority mismatch".into());
            }
            notification.summary = intent.summary.into();
            notification.read_at = None;
            ctx.db.notification().id().update(notification);
            let result = (
                group.notification_id,
                group.group_key.clone(),
                group.group_revision,
                group.window_started_at,
                group.window_expires_at,
            );
            ctx.db.notification_group().base_key().update(group);
            result
        } else {
            let notification_id = new_id(ctx)?;
            let group_key = new_id(ctx)?.to_string();
            let window_expires_at = ctx.timestamp
                + TimeDuration::from_micros(NOTIFICATION_GROUP_WINDOW_SECONDS * 1_000_000);
            ctx.db.notification().insert(Notification {
                id: notification_id,
                workspace_id: intent.workspace_id,
                recipient_identity: intent.recipient_identity,
                kind: intent.kind,
                resource_type: intent.resource_type.into(),
                resource_id: intent.resource_id,
                summary: intent.summary.into(),
                read_at: None,
                created_at: ctx.timestamp,
            });
            let group = NotificationGroup {
                base_key,
                group_key: group_key.clone(),
                notification_id,
                group_revision: 1,
                window_started_at: ctx.timestamp,
                window_expires_at,
                updated_at: ctx.timestamp,
            };
            if existing_group.is_some() {
                ctx.db.notification_group().base_key().update(group);
            } else {
                ctx.db.notification_group().insert(group);
            }
            (
                notification_id,
                group_key,
                1,
                ctx.timestamp,
                window_expires_at,
            )
        };
    let permission_current = notification_resource_visible_to(
        ctx,
        intent.workspace_id,
        intent.recipient_identity,
        intent.resource_type,
        intent.resource_id,
    );
    let delivery_allowed = crate::policy::notification_delivery_allowed(
        permission_current,
        preference.mode == NotificationDeliveryMode::Immediate,
        preference.mute_window_configured,
    );
    let suppression_reason = if !permission_current {
        "permission_revoked"
    } else if preference.mute_window_configured {
        "mute_window"
    } else {
        match preference.mode {
            NotificationDeliveryMode::Immediate => "",
            NotificationDeliveryMode::Digest => "digest",
            NotificationDeliveryMode::Disabled => "disabled",
        }
    };
    let occurrence_count = ctx
        .db
        .notification_control()
        .notification_id()
        .find(notification_id)
        .map(|control| {
            control
                .occurrence_count
                .checked_add(1)
                .ok_or_else(|| "notification occurrence count exhausted".to_string())
        })
        .transpose()?
        .unwrap_or(1);
    let control = NotificationControl {
        notification_id,
        workspace_id: intent.workspace_id,
        recipient_identity: intent.recipient_identity,
        space_id: intent.space_id,
        tier,
        event_class: intent.kind,
        resource_type: intent.resource_type.into(),
        resource_id: intent.resource_id,
        resource_revision,
        group_key: group_key.clone(),
        group_revision,
        occurrence_count,
        membership_epoch: membership.authz_epoch,
        preference_revision: preference.revision,
        channel: "email".into(),
        delivery_state: if delivery_allowed {
            NotificationDeliveryState::Pending
        } else {
            NotificationDeliveryState::Suppressed
        },
        suppression_reason: suppression_reason.into(),
        window_started_at,
        window_expires_at,
        created_at: ctx
            .db
            .notification_control()
            .notification_id()
            .find(notification_id)
            .map_or(ctx.timestamp, |control| control.created_at),
        updated_at: ctx.timestamp,
    };
    if ctx
        .db
        .notification_control()
        .notification_id()
        .find(notification_id)
        .is_some()
    {
        ctx.db
            .notification_control()
            .notification_id()
            .update(control);
    } else {
        ctx.db.notification_control().insert(control);
    }
    if preference.mode == NotificationDeliveryMode::Digest {
        register_notification_digest(
            ctx,
            notification_id,
            intent.workspace_id,
            intent.recipient_identity,
            "email",
            &preference,
        )?;
    }
    if delivery_allowed {
        enqueue_outbox(
            ctx,
            OutboxInsert {
                workspace_id: intent.workspace_id,
                kind: JOB_NOTIFICATION_DELIVER,
                resource_type: "notification",
                resource_id: notification_id,
                resource_revision: group_revision,
                effect_key: format!(
                    "notification:{notification_id}:group:{group_key}:revision:{group_revision}"
                ),
                payload: OutboxSemanticPayload {
                    intent_id: Some(notification_id),
                    recipient_id: Some(intent.recipient_identity),
                    channel: "email".into(),
                    authorization_epoch: Some(membership.authz_epoch),
                    minimal_message: intent.summary.into(),
                    payload_resource_id: Some(intent.resource_id),
                    version: Some(group_revision),
                    ..Default::default()
                },
            },
        )?;
    }
    Ok(Some(notification_id))
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
    revoke_agent_outbox(ctx, run_id, "agent_run_revoked");
}

fn revoke_agent_outbox(ctx: &ReducerContext, run_id: Uuid, reason: &str) {
    let job_ids: Vec<_> = ctx
        .db
        .outbox_job()
        .iter()
        .filter(|job| job.kind == JOB_AGENT_RUN && job.resource_id == run_id)
        .filter(|job| {
            crate::policy::revoke_outbox_job(
                matches!(job.state, OutboxState::Succeeded | OutboxState::DeadLetter),
                job.run_id == Some(run_id),
            )
        })
        .map(|job| job.id)
        .collect();
    for job_id in job_ids {
        let Some(mut job) = ctx.db.outbox_job().id().find(job_id) else {
            continue;
        };
        job.state = OutboxState::DeadLetter;
        job.last_error = reason.into();
        job.lease_owner = None;
        job.worker_slot_id.clear();
        job.lease_until = None;
        job.updated_at = ctx.timestamp;
        ctx.db.outbox_job().id().update(job);
    }
}

fn drain_agent_run_children(ctx: &ReducerContext, run_id: Uuid) -> bool {
    let approval_ids: Vec<_> = [ApprovalState::Pending, ApprovalState::Approved]
        .into_iter()
        .flat_map(|state| {
            ctx.db
                .approval_request()
                .run_state()
                .filter((run_id, state))
        })
        .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
        .map(|approval| approval.id)
        .collect();
    for approval_id in approval_ids {
        let Some(mut approval) = ctx.db.approval_request().id().find(approval_id) else {
            continue;
        };
        approval.state = ApprovalState::Rejected;
        approval.decided_at = Some(ctx.timestamp);
        ctx.db.approval_request().id().update(approval);
    }

    let tool_ids: Vec<_> = [
        ToolCallState::Proposed,
        ToolCallState::AwaitingApproval,
        ToolCallState::Approved,
        ToolCallState::Executing,
    ]
    .into_iter()
    .flat_map(|state| ctx.db.agent_tool_call().run_state().filter((run_id, state)))
    .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
    .map(|tool| tool.id)
    .collect();
    for tool_id in tool_ids {
        let Some(mut tool) = ctx.db.agent_tool_call().id().find(tool_id) else {
            continue;
        };
        if tool.state == ToolCallState::Executing {
            tool.state = ToolCallState::OutcomeUnknown;
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
        } else {
            tool.state = ToolCallState::Canceled;
        }
        tool.updated_at = ctx.timestamp;
        ctx.db.agent_tool_call().id().update(tool);
    }

    let approvals_remain = [ApprovalState::Pending, ApprovalState::Approved]
        .into_iter()
        .any(|state| {
            ctx.db
                .approval_request()
                .run_state()
                .filter((run_id, state))
                .next()
                .is_some()
        });
    let tools_remain = [
        ToolCallState::Proposed,
        ToolCallState::AwaitingApproval,
        ToolCallState::Approved,
        ToolCallState::Executing,
    ]
    .into_iter()
    .any(|state| {
        ctx.db
            .agent_tool_call()
            .run_state()
            .filter((run_id, state))
            .next()
            .is_some()
    });
    !approvals_remain && !tools_remain
}

fn drain_workspace_runtime_batch(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    lifecycle_state: WorkspaceLifecycleState,
) -> Result<(), String> {
    if lifecycle_state == WorkspaceLifecycleState::DeletionFenced {
        let ready_exports: Vec<_> = ctx
            .db
            .workspace_export()
            .workspace_state()
            .filter((workspace_id, WorkspaceExportState::Ready))
            .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
            .collect();
        for export in ready_exports {
            require_workspace_export_cleanup(ctx, export)?;
        }
        let run_id = [
            AgentRunState::Queued,
            AgentRunState::Authorizing,
            AgentRunState::CollectingContext,
            AgentRunState::Running,
            AgentRunState::AwaitingApproval,
            AgentRunState::ExecutingTool,
        ]
        .into_iter()
        .find_map(|state| {
            ctx.db
                .agent_run()
                .workspace_state()
                .filter((workspace_id, state))
                .next()
                .map(|run| run.id)
        });
        if let Some(run_id) = run_id
            && drain_agent_run_children(ctx, run_id)
            && let Some(mut run) = ctx.db.agent_run().id().find(run_id)
        {
            run.cancel_requested = true;
            run.state = AgentRunState::Revoked;
            run.lease_owner = None;
            run.lease_until = None;
            run.version = run.version.saturating_add(1);
            run.updated_at = ctx.timestamp;
            ctx.db.agent_run().id().update(run);
        }

        let job_ids: Vec<_> = [
            OutboxState::Pending,
            OutboxState::Leased,
            OutboxState::Retry,
            OutboxState::OutcomeUnknown,
        ]
        .into_iter()
        .flat_map(|state| {
            ctx.db
                .outbox_job()
                .workspace_state()
                .filter((workspace_id, state))
        })
        .filter(|job| {
            job.kind != JOB_WORKSPACE_EXPORT_CLEANUP
                && !(job.kind == JOB_WORKSPACE_EXPORT_GENERATE
                    && matches!(job.state, OutboxState::Leased | OutboxState::OutcomeUnknown))
        })
        .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
        .map(|job| job.id)
        .collect();
        for job_id in job_ids {
            let Some(mut job) = ctx.db.outbox_job().id().find(job_id) else {
                continue;
            };
            job.state = OutboxState::DeadLetter;
            job.last_error = "workspace_lifecycle_fenced".into();
            job.lease_owner = None;
            job.worker_slot_id.clear();
            job.lease_until = None;
            job.updated_at = ctx.timestamp;
            ctx.db.outbox_job().id().update(job);
        }
    }

    let permit_job_ids: Vec<_> = ctx
        .db
        .notification_delivery_permit()
        .workspace_id()
        .filter(workspace_id)
        .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
        .map(|permit| permit.job_id)
        .collect();
    for job_id in permit_job_ids {
        ctx.db
            .notification_delivery_permit()
            .job_id()
            .delete(job_id);
    }

    let digest_claim_ids: Vec<_> = ctx
        .db
        .notification_digest_claim()
        .workspace_id()
        .filter(workspace_id)
        .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
        .map(|claim| claim.claim_id)
        .collect();
    for claim_id in digest_claim_ids {
        ctx.db
            .notification_digest_permit()
            .claim_id()
            .delete(claim_id);
        ctx.db
            .notification_digest_claim()
            .claim_id()
            .delete(claim_id);
    }

    let presence_keys: Vec<_> = ctx
        .db
        .presence_session()
        .workspace_id()
        .filter(workspace_id)
        .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
        .map(|session| session.key)
        .collect();
    for presence_key in presence_keys {
        remove_presence_session(ctx, &presence_key);
    }

    let current_presence_keys: Vec<_> = ctx
        .db
        .current_presence()
        .workspace_id()
        .filter(workspace_id)
        .take(WORKSPACE_LIFECYCLE_DRAIN_BATCH)
        .map(|presence| presence.key)
        .collect();
    for key in current_presence_keys {
        ctx.db.current_presence().key().delete(key);
    }
    Ok(())
}

fn workspace_runtime_drain_pending(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    lifecycle_state: WorkspaceLifecycleState,
) -> bool {
    let irreversible_work_pending = lifecycle_state == WorkspaceLifecycleState::DeletionFenced
        && ([
            AgentRunState::Queued,
            AgentRunState::Authorizing,
            AgentRunState::CollectingContext,
            AgentRunState::Running,
            AgentRunState::AwaitingApproval,
            AgentRunState::ExecutingTool,
        ]
        .into_iter()
        .any(|state| {
            ctx.db
                .agent_run()
                .workspace_state()
                .filter((workspace_id, state))
                .next()
                .is_some()
        }) || [
            OutboxState::Pending,
            OutboxState::Leased,
            OutboxState::Retry,
            OutboxState::OutcomeUnknown,
        ]
        .into_iter()
        .any(|state| {
            ctx.db
                .outbox_job()
                .workspace_state()
                .filter((workspace_id, state))
                .any(|job| job.kind != JOB_WORKSPACE_EXPORT_CLEANUP)
        }));
    irreversible_work_pending
        || (lifecycle_state == WorkspaceLifecycleState::DeletionFenced
            && ctx
                .db
                .workspace_export()
                .workspace_state()
                .filter((workspace_id, WorkspaceExportState::Ready))
                .next()
                .is_some())
        || ctx
            .db
            .notification_delivery_permit()
            .workspace_id()
            .filter(workspace_id)
            .next()
            .is_some()
        || ctx
            .db
            .notification_digest_claim()
            .workspace_id()
            .filter(workspace_id)
            .next()
            .is_some()
        || ctx
            .db
            .notification_digest_permit()
            .workspace_id()
            .filter(workspace_id)
            .next()
            .is_some()
        || ctx
            .db
            .presence_session()
            .workspace_id()
            .filter(workspace_id)
            .next()
            .is_some()
        || ctx
            .db
            .current_presence()
            .workspace_id()
            .filter(workspace_id)
            .next()
            .is_some()
}

fn schedule_workspace_lifecycle_drain(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    lifecycle_epoch: u64,
) {
    let scheduled_at = (ctx.timestamp + TimeDuration::from_micros(1_000_000)).into();
    if let Some(existing) = ctx
        .db
        .workspace_lifecycle_drain_schedule()
        .workspace_id()
        .find(workspace_id)
    {
        ctx.db
            .workspace_lifecycle_drain_schedule()
            .scheduled_id()
            .update(WorkspaceLifecycleDrainSchedule {
                scheduled_id: existing.scheduled_id,
                scheduled_at,
                workspace_id,
                lifecycle_epoch,
            });
    } else {
        ctx.db
            .workspace_lifecycle_drain_schedule()
            .insert(WorkspaceLifecycleDrainSchedule {
                scheduled_id: 0,
                scheduled_at,
                workspace_id,
                lifecycle_epoch,
            });
    }
}

#[spacetimedb::reducer]
pub fn drain_workspace_lifecycle_schedule(
    ctx: &ReducerContext,
    schedule: WorkspaceLifecycleDrainSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("workspace lifecycle drain may only be invoked by the scheduler".into());
    }
    let Some(lifecycle) = ctx
        .db
        .workspace_lifecycle()
        .workspace_id()
        .find(schedule.workspace_id)
    else {
        return Ok(());
    };
    if lifecycle.state == WorkspaceLifecycleState::Active
        || lifecycle.lifecycle_epoch != schedule.lifecycle_epoch
    {
        return Ok(());
    }
    drain_workspace_runtime_batch(ctx, schedule.workspace_id, lifecycle.state)?;
    if workspace_runtime_drain_pending(ctx, schedule.workspace_id, lifecycle.state) {
        schedule_workspace_lifecycle_drain(ctx, schedule.workspace_id, schedule.lifecycle_epoch);
    }
    Ok(())
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
    for mut job in ctx
        .db
        .outbox_job()
        .state()
        .filter(OutboxState::Pending)
        .chain(ctx.db.outbox_job().state().filter(OutboxState::Retry))
        .chain(
            ctx.db
                .outbox_job()
                .state()
                .filter(OutboxState::OutcomeUnknown),
        )
        .chain(ctx.db.outbox_job().state().filter(OutboxState::Leased))
        .filter(|job| {
            job.kind == JOB_NOTIFICATION_DELIVER
                && (job.version.is_none()
                    || job.resource_revision == 0
                    || ctx
                        .db
                        .notification_control()
                        .notification_id()
                        .find(job.resource_id)
                        .is_none())
        })
    {
        job.state = OutboxState::DeadLetter;
        job.last_error = "legacy_notification_delivery_suppressed".into();
        job.lease_owner = None;
        job.worker_slot_id.clear();
        job.lease_until = None;
        job.updated_at = ctx.timestamp;
        ctx.db.outbox_job().id().update(job);
    }
    let workspace_ids: Vec<_> = ctx
        .db
        .workspace()
        .iter()
        .map(|workspace| workspace.id)
        .collect();
    for workspace_id in workspace_ids {
        if ctx
            .db
            .workspace_lifecycle()
            .workspace_id()
            .find(workspace_id)
            .is_none()
        {
            ctx.db
                .workspace_lifecycle()
                .insert(new_workspace_lifecycle(workspace_id, ctx.timestamp));
        }
    }
    for lifecycle in ctx.db.workspace_lifecycle().iter() {
        if ctx
            .db
            .workspace()
            .id()
            .find(lifecycle.workspace_id)
            .is_none()
            || !workspace_lifecycle_row_valid(&lifecycle)
        {
            return Err("workspace lifecycle migration invariant failed".into());
        }
    }
    for hold in ctx.db.workspace_legal_hold().iter() {
        let shape_valid = hold.revision > 0
            && !hold.reason.trim().is_empty()
            && match hold.state {
                WorkspaceLegalHoldState::Active => {
                    hold.released_by_identity.is_none()
                        && hold.released_by_subject.is_empty()
                        && hold.release_reason.is_empty()
                        && hold.released_at.is_none()
                }
                WorkspaceLegalHoldState::Released => {
                    hold.released_by_identity.is_some()
                        && !hold.released_by_subject.is_empty()
                        && !hold.release_reason.trim().is_empty()
                        && hold.released_at.is_some()
                }
            };
        if !shape_valid || ctx.db.workspace().id().find(hold.workspace_id).is_none() {
            return Err("workspace legal hold migration invariant failed".into());
        }
    }
    for export in ctx.db.workspace_export().iter() {
        let shape_valid = export.revision > 0
            && export.lifecycle_epoch > 0
            && export.workspace_revision > 0
            && match export.state {
                WorkspaceExportState::Requested => {
                    export.artifact_key.is_empty()
                        && export.content_hash.is_empty()
                        && export.artifact_version.is_empty()
                        && export.size_bytes == 0
                        && export.expires_at.is_none()
                }
                WorkspaceExportState::Ready => {
                    !export.artifact_key.is_empty()
                        && !export.content_hash.is_empty()
                        && crate::policy::workspace_export_artifact_version_valid(
                            &export.artifact_version,
                        )
                        && export.size_bytes > 0
                        && export.expires_at.is_some()
                }
                WorkspaceExportState::Failed => {
                    export.artifact_key.is_empty()
                        && export.content_hash.is_empty()
                        && export.artifact_version.is_empty()
                        && export.size_bytes == 0
                        && export.expires_at.is_none()
                        && !export.failure_reason.trim().is_empty()
                }
                WorkspaceExportState::Expired => {
                    !export.artifact_key.is_empty()
                        && !export.content_hash.is_empty()
                        && crate::policy::workspace_export_artifact_version_valid(
                            &export.artifact_version,
                        )
                        && export.size_bytes > 0
                        && export.expires_at.is_some()
                }
                WorkspaceExportState::Cleaned => {
                    export.artifact_key.is_empty()
                        && export.content_hash.is_empty()
                        && export.artifact_version.is_empty()
                        && export.size_bytes == 0
                        && export.expires_at.is_some()
                }
            };
        if !shape_valid || ctx.db.workspace().id().find(export.workspace_id).is_none() {
            return Err("workspace export migration invariant failed".into());
        }
    }
    for schedule in ctx.db.notification_digest_schedule().iter() {
        let overflow_valid = (schedule.overflow_count == 0 && schedule.overflow_revision == 0)
            || (schedule.overflow_count > 0
                && schedule.overflow_revision > 0
                && schedule.overflow_revision <= schedule.digest_revision);
        let shape_valid = schedule.digest_revision > 0
            && matches!(schedule.channel.as_str(), "email" | "push")
            && crate::policy::notification_preference_valid(
                None,
                None,
                schedule.digest_local_minute,
                &schedule.time_zone,
            )
            && (schedule.last_occurrence_local_date.is_empty()
                || crate::policy::notification_digest_local_date_valid(
                    &schedule.last_occurrence_local_date,
                ))
            && schedule.key
                == notification_digest_schedule_key(
                    schedule.workspace_id,
                    schedule.recipient_identity,
                    &schedule.preference_key,
                    &schedule.channel,
                )
            && overflow_valid;
        if !shape_valid
            || ctx
                .db
                .workspace()
                .id()
                .find(schedule.workspace_id)
                .is_none()
        {
            return Err("notification digest schedule migration invariant failed".into());
        }
    }
    for item in ctx.db.notification_digest_item().iter() {
        let Some(schedule) = ctx
            .db
            .notification_digest_schedule()
            .id()
            .find(item.schedule_id)
        else {
            return Err("notification digest item migration invariant failed".into());
        };
        if item.digest_revision == 0
            || item.digest_revision > schedule.digest_revision
            || ctx
                .db
                .notification()
                .id()
                .find(item.notification_id)
                .is_none()
            || ctx
                .db
                .notification_control()
                .notification_id()
                .find(item.notification_id)
                .is_none()
        {
            return Err("notification digest item migration invariant failed".into());
        }
    }
    for claim in ctx.db.notification_digest_claim().iter() {
        let Some(schedule) = ctx
            .db
            .notification_digest_schedule()
            .id()
            .find(claim.schedule_id)
        else {
            return Err("notification digest claim migration invariant failed".into());
        };
        let shape_valid = claim.workspace_id == schedule.workspace_id
            && claim.recipient_identity == schedule.recipient_identity
            && claim.channel == schedule.channel
            && claim.preference_revision <= schedule.preference_revision
            && claim.digest_revision > 0
            && claim.digest_revision <= schedule.digest_revision
            && claim.authorization_epoch > 0
            && crate::policy::notification_digest_local_date_valid(&claim.local_date)
            && schedule.last_occurrence_local_date >= claim.local_date
            && crate::policy::worker_slot_id_valid(&claim.worker_slot_id)
            && claim.lease_generation > 0
            && claim.attempt_count > 0
            && ctx
                .db
                .service_principal()
                .identity()
                .find(claim.service_identity)
                .is_some();
        if !shape_valid {
            return Err("notification digest claim migration invariant failed".into());
        }
    }
    for permit in ctx.db.notification_digest_permit().iter() {
        let Some(claim) = ctx
            .db
            .notification_digest_claim()
            .claim_id()
            .find(permit.claim_id)
        else {
            return Err("notification digest permit migration invariant failed".into());
        };
        let shape_valid = permit.workspace_id == claim.workspace_id
            && permit.schedule_id == claim.schedule_id
            && permit.service_identity == claim.service_identity
            && permit.worker_slot_id == claim.worker_slot_id
            && permit.lease_generation == claim.lease_generation
            && permit.preference_revision == claim.preference_revision
            && permit.digest_revision == claim.digest_revision
            && permit.authorization_epoch == claim.authorization_epoch
            && permit.expires_at <= claim.lease_until;
        if !shape_valid {
            return Err("notification digest permit migration invariant failed".into());
        }
    }
    for outcome in ctx.db.notification_digest_outcome().iter() {
        let Some(schedule) = ctx
            .db
            .notification_digest_schedule()
            .id()
            .find(outcome.schedule_id)
        else {
            return Err("notification digest outcome migration invariant failed".into());
        };
        let terminal_shape = match outcome.outcome {
            NotificationDigestTerminalOutcome::Succeeded => {
                crate::policy::notification_provider_reference_valid(&outcome.provider_reference)
                    && outcome.code.is_empty()
            }
            NotificationDigestTerminalOutcome::Suppressed
            | NotificationDigestTerminalOutcome::PermanentFailure => {
                outcome.provider_reference.is_empty() && !outcome.code.is_empty()
            }
        };
        if outcome.workspace_id != schedule.workspace_id
            || outcome.digest_revision == 0
            || outcome.digest_revision > schedule.digest_revision
            || !crate::policy::notification_digest_local_date_valid(&outcome.local_date)
            || outcome.occurrence_key
                != notification_digest_occurrence_key(outcome.schedule_id, &outcome.local_date)
            || !terminal_shape
        {
            return Err("notification digest outcome migration invariant failed".into());
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
    ctx.db
        .workspace_lifecycle()
        .insert(new_workspace_lifecycle(workspace_id, ctx.timestamp));
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
    ctx.db
        .workspace_lifecycle()
        .insert(new_workspace_lifecycle(id, ctx.timestamp));
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

fn workspace_lifecycle_owner(
    ctx: &ReducerContext,
    workspace_id: Uuid,
) -> Result<(Workspace, WorkspaceLifecycle), String> {
    require_registered_user(ctx)?;
    let workspace = ctx
        .db
        .workspace()
        .id()
        .find(workspace_id)
        .ok_or_else(|| "workspace lifecycle unavailable".to_string())?;
    if workspace.owner_identity != ctx.sender() {
        return Err("workspace lifecycle unavailable".into());
    }
    let owner_membership = ctx
        .db
        .workspace_member()
        .key()
        .find(workspace_member_key(workspace_id, ctx.sender()))
        .filter(|member| member.active && member.role == WorkspaceRole::Owner)
        .ok_or_else(|| "workspace lifecycle unavailable".to_string())?;
    if owner_membership.workspace_id != workspace_id {
        return Err("workspace lifecycle unavailable".into());
    }
    let lifecycle = ctx
        .db
        .workspace_lifecycle()
        .workspace_id()
        .find(workspace_id)
        .ok_or_else(|| "workspace lifecycle unavailable".to_string())?;
    if !workspace_lifecycle_row_valid(&lifecycle) {
        return Err("workspace lifecycle unavailable".into());
    }
    Ok((workspace, lifecycle))
}

fn advance_workspace_lifecycle(row: &mut WorkspaceLifecycle) -> Result<(), String> {
    row.lifecycle_epoch = row
        .lifecycle_epoch
        .checked_add(1)
        .ok_or_else(|| "workspace lifecycle epoch exhausted".to_string())?;
    row.revision = row
        .revision
        .checked_add(1)
        .ok_or_else(|| "workspace lifecycle revision exhausted".to_string())?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn place_workspace_legal_hold(
    ctx: &ReducerContext,
    input: PlaceWorkspaceLegalHoldInput,
) -> Result<(), String> {
    let PlaceWorkspaceLegalHoldInput {
        workspace_id,
        reason,
        client_request_id,
    } = input;
    validate_text(&reason, "legal hold reason", 500)?;
    let reason = reason.trim().to_string();
    let caller_subject = verified_oidc_subject(ctx)?;
    let input_hash = normalized_input_hash(&format!("{workspace_id}\0{reason}"));
    if existing_platform_receipt(
        ctx,
        "place_workspace_legal_hold",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let (_, operator_subject) = require_platform_operator(ctx)?;
    ctx.db
        .workspace()
        .id()
        .find(workspace_id)
        .ok_or_else(|| "workspace legal hold target unavailable".to_string())?;
    let lifecycle = ctx
        .db
        .workspace_lifecycle()
        .workspace_id()
        .find(workspace_id)
        .filter(workspace_lifecycle_row_valid)
        .ok_or_else(|| "workspace legal hold target unavailable".to_string())?;
    if lifecycle.state == WorkspaceLifecycleState::DeletionFenced
        || ctx
            .db
            .workspace_legal_hold()
            .workspace_state()
            .filter((workspace_id, WorkspaceLegalHoldState::Active))
            .take(MAX_ACTIVE_LEGAL_HOLDS_PER_WORKSPACE)
            .count()
            >= MAX_ACTIVE_LEGAL_HOLDS_PER_WORKSPACE
    {
        return Err("workspace legal hold placement denied".into());
    }
    let hold_id = new_id(ctx)?;
    ctx.db.workspace_legal_hold().insert(WorkspaceLegalHold {
        id: hold_id,
        workspace_id,
        state: WorkspaceLegalHoldState::Active,
        reason,
        placed_by_identity: ctx.sender(),
        placed_by_subject: operator_subject.clone(),
        placed_at: ctx.timestamp,
        released_by_identity: None,
        released_by_subject: String::new(),
        release_reason: String::new(),
        released_at: None,
        revision: 1,
        updated_at: ctx.timestamp,
    });
    insert_platform_receipt(
        ctx,
        "place_workspace_legal_hold",
        client_request_id,
        input_hash,
        operator_subject.clone(),
        1,
    );
    platform_audit(
        ctx,
        PlatformAuditInput {
            actor_subject: &operator_subject,
            workspace_id: Some(workspace_id),
            action: "place_workspace_legal_hold",
            resource: format!("workspace_legal_hold:{hold_id}"),
            request_id: client_request_id,
            summary: "workspace legal hold placed; deletion is blocked",
        },
    )
}

#[spacetimedb::reducer]
pub fn release_workspace_legal_hold(
    ctx: &ReducerContext,
    input: ReleaseWorkspaceLegalHoldInput,
) -> Result<(), String> {
    let ReleaseWorkspaceLegalHoldInput {
        hold_id,
        expected_revision,
        release_reason,
        client_request_id,
    } = input;
    validate_text(&release_reason, "legal hold release reason", 500)?;
    let release_reason = release_reason.trim().to_string();
    let caller_subject = verified_oidc_subject(ctx)?;
    let input_hash =
        normalized_input_hash(&format!("{hold_id}\0{expected_revision}\0{release_reason}"));
    if existing_platform_receipt(
        ctx,
        "release_workspace_legal_hold",
        client_request_id,
        &input_hash,
        &caller_subject,
    )? {
        return Ok(());
    }
    let (_, operator_subject) = require_platform_operator(ctx)?;
    let mut hold = ctx
        .db
        .workspace_legal_hold()
        .id()
        .find(hold_id)
        .ok_or_else(|| "workspace legal hold unavailable".to_string())?;
    revision_matches(hold.revision, expected_revision)?;
    if hold.state != WorkspaceLegalHoldState::Active {
        return Err("workspace legal hold release denied".into());
    }
    hold.state = WorkspaceLegalHoldState::Released;
    hold.released_by_identity = Some(ctx.sender());
    hold.released_by_subject = operator_subject.clone();
    hold.release_reason = release_reason;
    hold.released_at = Some(ctx.timestamp);
    hold.revision = hold
        .revision
        .checked_add(1)
        .ok_or_else(|| "workspace legal hold revision exhausted".to_string())?;
    hold.updated_at = ctx.timestamp;
    let workspace_id = hold.workspace_id;
    let committed_revision = hold.revision;
    ctx.db.workspace_legal_hold().id().update(hold);
    insert_platform_receipt(
        ctx,
        "release_workspace_legal_hold",
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
            action: "release_workspace_legal_hold",
            resource: format!("workspace_legal_hold:{hold_id}"),
            request_id: client_request_id,
            summary: "workspace legal hold released",
        },
    )
}

#[spacetimedb::reducer]
pub fn configure_workspace_lifecycle(
    ctx: &ReducerContext,
    input: ConfigureWorkspaceLifecycleInput,
) -> Result<(), String> {
    let ConfigureWorkspaceLifecycleInput {
        workspace_id,
        deleted_content_retention_days,
        deletion_grace_days,
        expected_revision,
        client_request_id,
    } = input;
    let (_, mut lifecycle) = workspace_lifecycle_owner(ctx, workspace_id)?;
    let input_hash = normalized_input_hash(&format!(
        "{workspace_id}\0{deleted_content_retention_days:?}\0{deletion_grace_days:?}\0{expected_revision}"
    ));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "configure_workspace_lifecycle",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(lifecycle.revision, expected_revision)?;
    if lifecycle.state != WorkspaceLifecycleState::Active
        || !crate::policy::workspace_lifecycle_configuration_valid(
            deleted_content_retention_days,
            deletion_grace_days,
        )
    {
        return Err("workspace lifecycle configuration denied".into());
    }
    lifecycle.deleted_content_retention_days = deleted_content_retention_days;
    lifecycle.deletion_grace_days = deletion_grace_days;
    lifecycle.revision = lifecycle
        .revision
        .checked_add(1)
        .ok_or_else(|| "workspace lifecycle revision exhausted".to_string())?;
    lifecycle.updated_at = ctx.timestamp;
    ctx.db
        .workspace_lifecycle()
        .workspace_id()
        .update(lifecycle.clone());
    insert_receipt(
        ctx,
        Some(workspace_id),
        "configure_workspace_lifecycle",
        client_request_id,
        input_hash,
        "workspace_lifecycle",
        workspace_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "configure_workspace_lifecycle",
            resource_type: "workspace_lifecycle",
            resource_id: workspace_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "workspace retention and deletion grace configuration updated",
        },
    )
}

#[spacetimedb::reducer]
pub fn request_workspace_deletion(
    ctx: &ReducerContext,
    input: WorkspaceLifecycleCommandInput,
) -> Result<(), String> {
    let WorkspaceLifecycleCommandInput {
        workspace_id,
        expected_revision,
        client_request_id,
    } = input;
    let (_, mut lifecycle) = workspace_lifecycle_owner(ctx, workspace_id)?;
    let input_hash = normalized_input_hash(&format!("{workspace_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "request_workspace_deletion",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(lifecycle.revision, expected_revision)?;
    let grace_days = lifecycle
        .deletion_grace_days
        .ok_or_else(|| "workspace deletion grace is not configured".to_string())?;
    if !crate::policy::workspace_lifecycle_transition_allowed(
        policy_workspace_lifecycle_state(lifecycle.state),
        crate::policy::PolicyWorkspaceLifecycleState::DeletionRequested,
        true,
        true,
        false,
        workspace_has_active_legal_hold(ctx, workspace_id),
    ) {
        return Err("workspace deletion request denied".into());
    }
    let execute_after =
        ctx.timestamp + TimeDuration::from_micros(i64::from(grace_days) * 24 * 60 * 60 * 1_000_000);
    lifecycle.state = WorkspaceLifecycleState::DeletionRequested;
    lifecycle.deletion_requested_by = Some(ctx.sender());
    lifecycle.deletion_requested_at = Some(ctx.timestamp);
    lifecycle.deletion_execute_after = Some(execute_after);
    advance_workspace_lifecycle(&mut lifecycle)?;
    lifecycle.updated_at = ctx.timestamp;
    let lifecycle_epoch = lifecycle.lifecycle_epoch;
    ctx.db
        .workspace_lifecycle()
        .workspace_id()
        .update(lifecycle);
    schedule_workspace_lifecycle_drain(ctx, workspace_id, lifecycle_epoch);
    insert_receipt(
        ctx,
        Some(workspace_id),
        "request_workspace_deletion",
        client_request_id,
        input_hash,
        "workspace_lifecycle",
        workspace_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "request_workspace_deletion",
            resource_type: "workspace_lifecycle",
            resource_id: workspace_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "workspace deletion requested; access and runtime work fenced",
        },
    )
}

#[spacetimedb::reducer]
pub fn cancel_workspace_deletion(
    ctx: &ReducerContext,
    input: WorkspaceLifecycleCommandInput,
) -> Result<(), String> {
    let WorkspaceLifecycleCommandInput {
        workspace_id,
        expected_revision,
        client_request_id,
    } = input;
    let (_, mut lifecycle) = workspace_lifecycle_owner(ctx, workspace_id)?;
    let input_hash = normalized_input_hash(&format!("{workspace_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "cancel_workspace_deletion",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(lifecycle.revision, expected_revision)?;
    if !crate::policy::workspace_lifecycle_transition_allowed(
        policy_workspace_lifecycle_state(lifecycle.state),
        crate::policy::PolicyWorkspaceLifecycleState::Active,
        true,
        lifecycle.deletion_grace_days.is_some(),
        false,
        workspace_has_active_legal_hold(ctx, workspace_id),
    ) {
        return Err("workspace deletion cancellation denied".into());
    }
    lifecycle.state = WorkspaceLifecycleState::Active;
    lifecycle.deletion_requested_by = None;
    lifecycle.deletion_requested_at = None;
    lifecycle.deletion_execute_after = None;
    advance_workspace_lifecycle(&mut lifecycle)?;
    lifecycle.updated_at = ctx.timestamp;
    ctx.db
        .workspace_lifecycle()
        .workspace_id()
        .update(lifecycle);
    if let Some(schedule) = ctx
        .db
        .workspace_lifecycle_drain_schedule()
        .workspace_id()
        .find(workspace_id)
    {
        ctx.db
            .workspace_lifecycle_drain_schedule()
            .scheduled_id()
            .delete(schedule.scheduled_id);
    }
    insert_receipt(
        ctx,
        Some(workspace_id),
        "cancel_workspace_deletion",
        client_request_id,
        input_hash,
        "workspace_lifecycle",
        workspace_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "cancel_workspace_deletion",
            resource_type: "workspace_lifecycle",
            resource_id: workspace_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "workspace deletion request canceled; prior jobs remain revoked",
        },
    )
}

#[spacetimedb::reducer]
pub fn finalize_workspace_deletion_fence(
    ctx: &ReducerContext,
    input: WorkspaceLifecycleCommandInput,
) -> Result<(), String> {
    let WorkspaceLifecycleCommandInput {
        workspace_id,
        expected_revision,
        client_request_id,
    } = input;
    let (_, mut lifecycle) = workspace_lifecycle_owner(ctx, workspace_id)?;
    let input_hash = normalized_input_hash(&format!("{workspace_id}\0{expected_revision}"));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "finalize_workspace_deletion_fence",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(lifecycle.revision, expected_revision)?;
    let grace_elapsed = lifecycle
        .deletion_execute_after
        .is_some_and(|execute_after| execute_after <= ctx.timestamp);
    if !crate::policy::workspace_lifecycle_transition_allowed(
        policy_workspace_lifecycle_state(lifecycle.state),
        crate::policy::PolicyWorkspaceLifecycleState::DeletionFenced,
        true,
        lifecycle.deletion_grace_days.is_some(),
        grace_elapsed,
        workspace_has_active_legal_hold(ctx, workspace_id),
    ) {
        return Err("workspace deletion fence cannot be finalized".into());
    }
    lifecycle.state = WorkspaceLifecycleState::DeletionFenced;
    advance_workspace_lifecycle(&mut lifecycle)?;
    lifecycle.updated_at = ctx.timestamp;
    let lifecycle_epoch = lifecycle.lifecycle_epoch;
    ctx.db
        .workspace_lifecycle()
        .workspace_id()
        .update(lifecycle);
    schedule_workspace_lifecycle_drain(ctx, workspace_id, lifecycle_epoch);
    insert_receipt(
        ctx,
        Some(workspace_id),
        "finalize_workspace_deletion_fence",
        client_request_id,
        input_hash,
        "workspace_lifecycle",
        workspace_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "finalize_workspace_deletion_fence",
            resource_type: "workspace_lifecycle",
            resource_id: workspace_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "irreversible workspace access fence finalized; provider purge remains separate",
        },
    )
}

#[spacetimedb::reducer]
pub fn request_workspace_export(
    ctx: &ReducerContext,
    input: RequestWorkspaceExportInput,
) -> Result<(), String> {
    let RequestWorkspaceExportInput {
        workspace_id,
        client_request_id,
    } = input;
    let (workspace, lifecycle) = workspace_lifecycle_owner(ctx, workspace_id)?;
    let input_hash = normalized_input_hash(&workspace_id.to_string());
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "request_workspace_export",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let active_exports = [WorkspaceExportState::Requested, WorkspaceExportState::Ready]
        .into_iter()
        .map(|state| {
            ctx.db
                .workspace_export()
                .workspace_state()
                .filter((workspace_id, state))
                .take(MAX_ACTIVE_EXPORTS_PER_WORKSPACE)
                .count()
        })
        .sum::<usize>();
    if lifecycle.state != WorkspaceLifecycleState::Active
        || active_exports >= MAX_ACTIVE_EXPORTS_PER_WORKSPACE
    {
        return Err("workspace export request denied".into());
    }
    let export_id = new_id(ctx)?;
    let export = WorkspaceExport {
        id: export_id,
        workspace_id,
        requested_by: ctx.sender(),
        state: WorkspaceExportState::Requested,
        lifecycle_epoch: lifecycle.lifecycle_epoch,
        workspace_revision: workspace.revision,
        artifact_key: String::new(),
        content_hash: String::new(),
        artifact_version: String::new(),
        size_bytes: 0,
        expires_at: None,
        failure_reason: String::new(),
        revision: 1,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };
    ctx.db.workspace_export().insert(export);
    enqueue_outbox(
        ctx,
        OutboxInsert {
            workspace_id,
            kind: JOB_WORKSPACE_EXPORT_GENERATE,
            resource_type: "workspace_export",
            resource_id: export_id,
            resource_revision: 1,
            effect_key: format!("workspace:{workspace_id}:export:{export_id}:1"),
            payload: OutboxSemanticPayload {
                payload_resource_id: Some(export_id),
                version: Some(1),
                ..Default::default()
            },
        },
    )?;
    insert_receipt(
        ctx,
        Some(workspace_id),
        "request_workspace_export",
        client_request_id,
        input_hash,
        "workspace_export",
        export_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id,
            action: "request_workspace_export",
            resource_type: "workspace_export",
            resource_id: export_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "owner requested a bounded workspace export",
        },
    )
}

#[spacetimedb::reducer]
pub fn complete_workspace_export(
    ctx: &ReducerContext,
    input: CompleteWorkspaceExportInput,
) -> Result<(), String> {
    let CompleteWorkspaceExportInput {
        export_id,
        job_id,
        lease_generation,
        worker_slot_id,
        outcome,
        artifact_key,
        content_hash,
        artifact_version,
        size_bytes,
        error,
        retry_after_seconds,
    } = input;
    if !crate::policy::worker_slot_id_valid(&worker_slot_id)
        || artifact_key.len() > 1_024
        || artifact_version.len() > 256
        || error.len() > 2_000
        || (outcome == WorkspaceExportCompletionOutcome::Ready && retry_after_seconds != 0)
    {
        return Err("workspace export completion input is invalid".into());
    }
    let hash_valid =
        content_hash.len() == 64 && content_hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !content_hash.is_empty() && !hash_valid {
        return Err("workspace export content hash is invalid".into());
    }
    let ready = outcome == WorkspaceExportCompletionOutcome::Ready;
    if (ready && !crate::policy::workspace_export_artifact_version_valid(&artifact_version))
        || (!ready && !artifact_version.is_empty())
    {
        return Err("workspace export artifact version is invalid".into());
    }
    if !crate::policy::workspace_export_completion_valid(
        ready,
        !artifact_key.trim().is_empty(),
        hash_valid,
        size_bytes,
        !error.trim().is_empty(),
    ) {
        return Err("workspace export completion shape is invalid".into());
    }
    let mut export = ctx
        .db
        .workspace_export()
        .id()
        .find(export_id)
        .ok_or_else(|| "workspace export unavailable".to_string())?;
    require_export_generation_completion_service(ctx, export.workspace_id)?;
    let lifecycle_current = ctx
        .db
        .workspace_lifecycle()
        .workspace_id()
        .find(export.workspace_id)
        .is_some_and(|lifecycle| {
            lifecycle.state == WorkspaceLifecycleState::Active
                && lifecycle.lifecycle_epoch == export.lifecycle_epoch
        });
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "workspace export job unavailable".to_string())?;
    let exact_binding = export.state == WorkspaceExportState::Requested
        && job.workspace_id == export.workspace_id
        && job.kind == JOB_WORKSPACE_EXPORT_GENERATE
        && job.resource_type == "workspace_export"
        && job.resource_id == export.id
        && job.resource_revision == export.revision
        && job.payload_resource_id == Some(export.id)
        && job.version == Some(export.revision)
        && job.state == OutboxState::Leased
        && job.lease_owner == Some(ctx.sender())
        && job.worker_slot_id == worker_slot_id
        && job.lease_generation == lease_generation
        && job.lease_until.is_some_and(|expiry| expiry > ctx.timestamp)
        && (!ready
            || crate::policy::workspace_export_artifact_key_valid(
                &export.workspace_id.to_string(),
                &export_id.to_string(),
                &artifact_key,
            ));
    if !exact_binding {
        return Err("workspace export completion authority is stale".into());
    }
    match outcome {
        WorkspaceExportCompletionOutcome::Ready => {
            let expires_at = ctx.timestamp
                + TimeDuration::from_micros(
                    crate::policy::WORKSPACE_EXPORT_TTL_SECONDS * 1_000_000,
                );
            export.state = WorkspaceExportState::Ready;
            export.artifact_key = artifact_key;
            export.content_hash = content_hash.to_ascii_lowercase();
            export.artifact_version = artifact_version;
            export.size_bytes = size_bytes;
            export.expires_at = Some(expires_at);
            export.failure_reason.clear();
            export.revision = export
                .revision
                .checked_add(1)
                .ok_or_else(|| "workspace export revision exhausted".to_string())?;
            export.updated_at = ctx.timestamp;
            ctx.db.workspace_export().id().update(export.clone());
            match crate::policy::workspace_export_materialization_disposition(
                lifecycle_current,
                ctx.timestamp <= job.expires_at,
            ) {
                crate::policy::WorkspaceExportMaterializationDisposition::PublishReady => {
                    ctx.db.workspace_export_expiry_schedule().insert(
                        WorkspaceExportExpirySchedule {
                            scheduled_id: 0,
                            scheduled_at: expires_at.into(),
                            export_id,
                            expected_revision: export.revision,
                        },
                    );
                }
                crate::policy::WorkspaceExportMaterializationDisposition::CleanupRequired => {
                    require_workspace_export_cleanup(ctx, export)?;
                }
            }
            job.state = OutboxState::Succeeded;
            job.last_error.clear();
        }
        WorkspaceExportCompletionOutcome::Retry => {
            job.state = OutboxState::Retry;
            job.last_error = error;
        }
        WorkspaceExportCompletionOutcome::OutcomeUnknown => {
            job.state = OutboxState::OutcomeUnknown;
            job.last_error = error;
        }
        WorkspaceExportCompletionOutcome::Failed => {
            export.state = WorkspaceExportState::Failed;
            export.failure_reason = error.clone();
            export.revision = export
                .revision
                .checked_add(1)
                .ok_or_else(|| "workspace export revision exhausted".to_string())?;
            export.updated_at = ctx.timestamp;
            ctx.db.workspace_export().id().update(export);
            job.state = OutboxState::DeadLetter;
            job.last_error = error;
        }
    }
    job.next_attempt_at = ctx.timestamp
        + TimeDuration::from_micros(i64::from(retry_after_seconds.min(86_400)) * 1_000_000);
    job.lease_owner = None;
    job.worker_slot_id.clear();
    job.lease_until = None;
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}

#[spacetimedb::reducer]
pub fn expire_workspace_export_schedule(
    ctx: &ReducerContext,
    schedule: WorkspaceExportExpirySchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("workspace export expiry may only be invoked by the scheduler".into());
    }
    let Some(export) = ctx.db.workspace_export().id().find(schedule.export_id) else {
        return Ok(());
    };
    if export.state != WorkspaceExportState::Ready
        || export.revision != schedule.expected_revision
        || export
            .expires_at
            .is_none_or(|expiry| expiry > ctx.timestamp)
    {
        return Ok(());
    }
    require_workspace_export_cleanup(ctx, export)?;
    Ok(())
}

#[spacetimedb::reducer]
pub fn complete_workspace_export_cleanup(
    ctx: &ReducerContext,
    input: CompleteWorkspaceExportCleanupInput,
) -> Result<(), String> {
    let CompleteWorkspaceExportCleanupInput {
        export_id,
        job_id,
        lease_generation,
        worker_slot_id,
        outcome,
        error,
        retry_after_seconds,
    } = input;
    let cleanup_succeeded = matches!(
        outcome,
        WorkspaceExportCleanupOutcome::Deleted | WorkspaceExportCleanupOutcome::NotFound
    );
    if !crate::policy::worker_slot_id_valid(&worker_slot_id)
        || error.len() > 2_000
        || cleanup_succeeded != error.is_empty()
        || (cleanup_succeeded && retry_after_seconds != 0)
    {
        return Err("workspace export cleanup completion input is invalid".into());
    }
    let mut export = ctx
        .db
        .workspace_export()
        .id()
        .find(export_id)
        .ok_or_else(|| "workspace export cleanup unavailable".to_string())?;
    require_service(ctx, export.workspace_id, JOB_WORKSPACE_EXPORT_CLEANUP)?;
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "workspace export cleanup job unavailable".to_string())?;
    let exact_binding = export.state == WorkspaceExportState::Expired
        && job.workspace_id == export.workspace_id
        && job.kind == JOB_WORKSPACE_EXPORT_CLEANUP
        && job.resource_type == "workspace_export"
        && job.resource_id == export.id
        && job.resource_revision == export.revision
        && job.payload_resource_id == Some(export.id)
        && job.version == Some(export.revision)
        && job.state == OutboxState::Leased
        && job.lease_owner == Some(ctx.sender())
        && job.worker_slot_id == worker_slot_id
        && job.lease_generation == lease_generation
        && job.lease_until.is_some_and(|expiry| expiry > ctx.timestamp)
        && crate::policy::workspace_export_artifact_key_valid(
            &export.workspace_id.to_string(),
            &export.id.to_string(),
            &export.artifact_key,
        )
        && export.content_hash.len() == 64
        && export
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        && crate::policy::workspace_export_artifact_version_valid(&export.artifact_version)
        && crate::policy::workspace_export_size_valid(export.size_bytes);
    if !exact_binding {
        return Err("workspace export cleanup authority is stale".into());
    }
    match outcome {
        WorkspaceExportCleanupOutcome::Deleted | WorkspaceExportCleanupOutcome::NotFound => {
            export.state = WorkspaceExportState::Cleaned;
            export.artifact_key.clear();
            export.content_hash.clear();
            export.artifact_version.clear();
            export.size_bytes = 0;
            export.failure_reason.clear();
            export.revision = export
                .revision
                .checked_add(1)
                .ok_or_else(|| "workspace export revision exhausted".to_string())?;
            export.updated_at = ctx.timestamp;
            ctx.db.workspace_export().id().update(export);
            job.state = OutboxState::Succeeded;
            job.last_error.clear();
        }
        WorkspaceExportCleanupOutcome::Retry => {
            job.state = OutboxState::Retry;
            job.last_error = error;
        }
        WorkspaceExportCleanupOutcome::OutcomeUnknown => {
            job.state = OutboxState::OutcomeUnknown;
            job.last_error = error;
        }
        WorkspaceExportCleanupOutcome::Failed => {
            job.state = OutboxState::DeadLetter;
            job.last_error = error;
        }
    }
    job.next_attempt_at = ctx.timestamp
        + TimeDuration::from_micros(i64::from(retry_after_seconds.min(86_400)) * 1_000_000);
    job.lease_owner = None;
    job.worker_slot_id.clear();
    job.lease_until = None;
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}

#[spacetimedb::reducer]
pub fn request_search_rebuild(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    generation: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    require_workspace_action(ctx, workspace_id, Action::ManageWorkspace)?;
    if generation == 0 {
        return Err("search rebuild generation must be positive".into());
    }
    let input_hash = normalized_input_hash(&format!("{workspace_id}\0{generation}"));
    if existing_receipt(
        ctx,
        Some(workspace_id),
        "request_search_rebuild",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let rebuild_id = new_id(ctx)?;
    enqueue_outbox(
        ctx,
        OutboxInsert {
            workspace_id,
            kind: JOB_SEARCH_REBUILD,
            resource_type: "search_rebuild",
            resource_id: rebuild_id,
            resource_revision: generation,
            effect_key: format!("search-rebuild:{workspace_id}:{generation}:{rebuild_id}"),
            payload: OutboxSemanticPayload {
                rebuild_id: Some(rebuild_id),
                generation: Some(generation),
                ..Default::default()
            },
        },
    )?;
    insert_receipt(
        ctx,
        Some(workspace_id),
        "request_search_rebuild",
        client_request_id,
        input_hash,
        "search_rebuild",
        rebuild_id,
    );
    Ok(())
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
    if !active {
        deactivate_direct_participation(ctx, workspace_id, identity);
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

fn normalized_post_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 10 {
        return Err("posts are limited to 10 tags".into());
    }
    let mut normalized = Vec::with_capacity(tags.len());
    for tag in tags {
        let tag = tag.trim().to_ascii_lowercase();
        if tag.is_empty()
            || tag.len() > 40
            || !tag.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err(
                "post tags must be 1-40 ASCII letters, numbers, hyphens, or underscores".into(),
            );
        }
        if !normalized.contains(&tag) {
            normalized.push(tag);
        }
    }
    normalized.sort();
    Ok(normalized)
}

fn validated_post_mentions(
    ctx: &ReducerContext,
    space: &Space,
    mentions: Vec<Identity>,
) -> Result<Vec<Identity>, String> {
    if mentions.len() > 50 {
        return Err("posts are limited to 50 mentions".into());
    }
    let mut unique = Vec::with_capacity(mentions.len());
    for identity in mentions {
        let active = find_membership(ctx, space.workspace_id, identity)
            .is_some_and(|member| member.active)
            && can_read_space(ctx, space, identity);
        if !active {
            return Err("mentioned identity cannot read this post's space".into());
        }
        if !unique.contains(&identity) {
            unique.push(identity);
        }
    }
    unique.sort_by_key(ToString::to_string);
    Ok(unique)
}

fn require_post_identity(
    ctx: &ReducerContext,
    post: &Post,
    identity: Identity,
) -> Result<(), String> {
    let space = ctx
        .db
        .space()
        .id()
        .find(post.space_id)
        .ok_or_else(|| "post space not found".to_string())?;
    if !find_membership(ctx, post.workspace_id, identity).is_some_and(|member| member.active)
        || !can_read_space(ctx, &space, identity)
    {
        return Err("post owner or assignee must be able to read the post space".into());
    }
    Ok(())
}

fn replace_post_metadata(
    ctx: &ReducerContext,
    post: &Post,
    tags: Vec<String>,
    mentions: Vec<Identity>,
) -> Result<(), String> {
    let existing_mentions: Vec<_> = ctx
        .db
        .post_mention()
        .post_id()
        .filter(post.id)
        .map(|row| row.identity)
        .collect();
    let tag_keys: Vec<_> = ctx
        .db
        .post_tag()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in tag_keys {
        ctx.db.post_tag().key().delete(key);
    }
    let mention_keys: Vec<_> = ctx
        .db
        .post_mention()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in mention_keys {
        ctx.db.post_mention().key().delete(key);
    }
    for tag in tags {
        ctx.db.post_tag().insert(PostTag {
            key: post_tag_key(post.id, &tag),
            post_id: post.id,
            workspace_id: post.workspace_id,
            space_id: post.space_id,
            tag,
            created_at: ctx.timestamp,
        });
    }
    for identity in mentions {
        ctx.db.post_mention().insert(PostMention {
            key: post_identity_key(post.id, identity),
            post_id: post.id,
            identity,
            workspace_id: post.workspace_id,
            space_id: post.space_id,
            created_at: ctx.timestamp,
        });
        if identity != ctx.sender() && !existing_mentions.contains(&identity) {
            coalesce_notification(
                ctx,
                NotificationIntent {
                    workspace_id: post.workspace_id,
                    space_id: Some(post.space_id),
                    recipient_identity: identity,
                    kind: NotificationKind::Mention,
                    resource_type: "post",
                    resource_id: post.id,
                    summary: "You were mentioned in a post",
                },
            )?;
        }
    }
    Ok(())
}

fn append_post_activity(
    ctx: &ReducerContext,
    post: &mut Post,
    kind: &str,
    summary: &str,
) -> Result<(), String> {
    post.activity_sequence = post
        .activity_sequence
        .checked_add(1)
        .ok_or_else(|| "post activity sequence exhausted".to_string())?;
    post.last_activity_at = ctx.timestamp;
    ctx.db.post_activity().insert(PostActivity {
        key: post_activity_key(post.id, post.activity_sequence),
        post_id: post.id,
        sequence: post.activity_sequence,
        actor_identity: ctx.sender(),
        kind: kind.into(),
        summary: summary.into(),
        created_at: ctx.timestamp,
    });
    Ok(())
}

fn create_post_record(
    ctx: &ReducerContext,
    input: CreateTypedPostInput,
    operation: &str,
) -> Result<(), String> {
    let CreateTypedPostInput {
        space_id,
        title,
        body,
        kind,
        owner_identity,
        assignee_identity,
        tags,
        mentions,
        client_request_id,
    } = input;
    let (space, _) = require_space_action(ctx, space_id, Action::Write)?;
    validate_text(&title, "post title", 200)?;
    validate_text(&body, "post body", 50_000)?;
    let tags = normalized_post_tags(tags)?;
    let mentions = validated_post_mentions(ctx, &space, mentions)?;
    let provisional = Post {
        id: Uuid::from_u128(0),
        workspace_id: space.workspace_id,
        space_id,
        author_identity: ctx.sender(),
        owner_identity,
        assignee_identity,
        kind,
        state: PostState::Active,
        locked: false,
        title: String::new(),
        body: String::new(),
        revision: 0,
        activity_sequence: 0,
        last_activity_at: ctx.timestamp,
        deleted: false,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };
    require_post_identity(ctx, &provisional, owner_identity)?;
    if let Some(identity) = assignee_identity {
        require_post_identity(ctx, &provisional, identity)?;
    }
    let input_hash = normalized_input_hash(&format!(
        "{space_id}\0{}\0{body}\0{kind:?}\0{owner_identity}\0{assignee_identity:?}\0{tags:?}\0{mentions:?}",
        title.trim()
    ));
    if existing_receipt(
        ctx,
        Some(space.workspace_id),
        operation,
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let id = new_id(ctx)?;
    let title = title.trim().to_string();
    let post = Post {
        id,
        workspace_id: space.workspace_id,
        space_id,
        author_identity: ctx.sender(),
        owner_identity,
        assignee_identity,
        kind,
        state: PostState::Active,
        locked: false,
        title: title.clone(),
        body: body.clone(),
        revision: 1,
        activity_sequence: 1,
        last_activity_at: ctx.timestamp,
        deleted: false,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };
    ctx.db.post().insert(post.clone());
    ctx.db.post_activity().insert(PostActivity {
        key: post_activity_key(id, 1),
        post_id: id,
        sequence: 1,
        actor_identity: ctx.sender(),
        kind: "created".into(),
        summary: "Post created".into(),
        created_at: ctx.timestamp,
    });
    ctx.db.post_user_state().insert(PostUserState {
        key: post_identity_key(id, ctx.sender()),
        post_id: id,
        identity: ctx.sender(),
        following: true,
        bookmarked: false,
        last_read_sequence: 1,
        read_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
    });
    replace_post_metadata(ctx, &post, tags, mentions)?;
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
        operation,
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
pub fn create_post(
    ctx: &ReducerContext,
    space_id: Uuid,
    title: String,
    body: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    create_post_record(
        ctx,
        CreateTypedPostInput {
            space_id,
            title,
            body,
            kind: PostKind::Discussion,
            owner_identity: ctx.sender(),
            assignee_identity: None,
            tags: Vec::new(),
            mentions: Vec::new(),
            client_request_id,
        },
        "create_post",
    )
}

#[spacetimedb::reducer]
pub fn create_typed_post(ctx: &ReducerContext, input: CreateTypedPostInput) -> Result<(), String> {
    create_post_record(ctx, input, "create_typed_post")
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
    if post.locked || post.state == PostState::Archived {
        return Err("locked or archived posts cannot be edited".into());
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
    append_post_activity(ctx, &mut post, "edited", "Post content edited")?;
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
    let is_admin = role_allows(member.role, Action::ManageWorkspace);
    if post.author_identity != ctx.sender() && !is_admin {
        return Err("only the author or an administrator may delete this post".into());
    }
    if post.locked && !is_admin {
        return Err("locked posts can only be deleted by an administrator".into());
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
    append_post_activity(ctx, &mut post, "deleted", "Post deleted")?;
    ctx.db.post().id().update(post.clone());
    let tag_keys: Vec<_> = ctx
        .db
        .post_tag()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in tag_keys {
        ctx.db.post_tag().key().delete(key);
    }
    let mention_keys: Vec<_> = ctx
        .db
        .post_mention()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in mention_keys {
        ctx.db.post_mention().key().delete(key);
    }
    let reaction_keys: Vec<_> = ctx
        .db
        .post_reaction()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in reaction_keys {
        ctx.db.post_reaction().key().delete(key);
    }
    ctx.db.post_pin().post_id().delete(post.id);
    let state_keys: Vec<_> = ctx
        .db
        .post_user_state()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in state_keys {
        ctx.db.post_user_state().key().delete(key);
    }
    let vote_keys: Vec<_> = ctx
        .db
        .poll_vote()
        .post_id()
        .filter(post.id)
        .map(|row| row.key)
        .collect();
    for key in vote_keys {
        ctx.db.poll_vote().key().delete(key);
    }
    let option_ids: Vec<_> = ctx
        .db
        .poll_option()
        .post_id()
        .filter(post.id)
        .map(|row| row.id)
        .collect();
    for option_id in option_ids {
        ctx.db.poll_option().id().delete(option_id);
    }
    ctx.db.poll().post_id().delete(post.id);
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
pub fn set_post_metadata(
    ctx: &ReducerContext,
    post_id: Uuid,
    tags: Vec<String>,
    mentions: Vec<Identity>,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (space, member) = require_space_action(ctx, post.space_id, Action::Write)?;
    let is_admin = role_allows(member.role, Action::ManageWorkspace);
    if post.author_identity != ctx.sender() && post.owner_identity != ctx.sender() && !is_admin {
        return Err("post metadata update denied".into());
    }
    if post.deleted || post.locked || post.state == PostState::Archived {
        return Err("post metadata cannot be changed in its current state".into());
    }
    let tags = normalized_post_tags(tags)?;
    let mentions = validated_post_mentions(ctx, &space, mentions)?;
    let input_hash = normalized_input_hash(&format!(
        "{post_id}\0{tags:?}\0{mentions:?}\0{expected_revision}"
    ));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "set_post_metadata",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(post.revision, expected_revision)?;
    post.revision = post.revision.saturating_add(1);
    post.updated_at = ctx.timestamp;
    append_post_activity(
        ctx,
        &mut post,
        "metadata_updated",
        "Post tags or mentions updated",
    )?;
    ctx.db.post().id().update(post.clone());
    replace_post_metadata(ctx, &post, tags, mentions)?;
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "set_post_metadata",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn update_post_lifecycle(
    ctx: &ReducerContext,
    input: UpdatePostLifecycleInput,
) -> Result<(), String> {
    let UpdatePostLifecycleInput {
        post_id,
        state,
        locked,
        owner_identity,
        assignee_identity,
        expected_revision,
        client_request_id,
    } = input;
    let mut post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (_, member) = require_space_action(ctx, post.space_id, Action::Write)?;
    if post.deleted {
        return Err("deleted post lifecycle cannot change".into());
    }
    let is_admin = role_allows(member.role, Action::ManageWorkspace);
    let ownership_changes =
        post.owner_identity != owner_identity || post.assignee_identity != assignee_identity;
    if !crate::policy::post_lifecycle_change_allowed(
        post.author_identity == ctx.sender() || post.owner_identity == ctx.sender(),
        is_admin,
        post.locked,
        state == PostState::Archived,
        post.locked != locked,
        ownership_changes,
    ) {
        return Err("post lifecycle update denied".into());
    }
    require_post_identity(ctx, &post, owner_identity)?;
    if let Some(identity) = assignee_identity {
        require_post_identity(ctx, &post, identity)?;
    }
    let input_hash = normalized_input_hash(&format!(
        "{post_id}\0{state:?}\0{locked}\0{owner_identity}\0{assignee_identity:?}\0{expected_revision}"
    ));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "update_post_lifecycle",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(post.revision, expected_revision)?;
    let previous_assignee = post.assignee_identity;
    post.state = state;
    post.locked = locked;
    post.owner_identity = owner_identity;
    post.assignee_identity = assignee_identity;
    post.revision = post.revision.saturating_add(1);
    post.updated_at = ctx.timestamp;
    append_post_activity(
        ctx,
        &mut post,
        "lifecycle_updated",
        "Post lifecycle updated",
    )?;
    ctx.db.post().id().update(post.clone());
    if let Some(identity) = assignee_identity
        && Some(identity) != previous_assignee
        && identity != ctx.sender()
    {
        coalesce_notification(
            ctx,
            NotificationIntent {
                workspace_id: post.workspace_id,
                space_id: Some(post.space_id),
                recipient_identity: identity,
                kind: NotificationKind::Assignment,
                resource_type: "post",
                resource_id: post.id,
                summary: "A post was assigned to you",
            },
        )?;
    }
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "update_post_lifecycle",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_post_reaction(
    ctx: &ReducerContext,
    post_id: Uuid,
    emoji: String,
    active: bool,
    client_request_id: Uuid,
) -> Result<(), String> {
    validate_text(&emoji, "reaction", 32)?;
    let post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    require_space_action(ctx, post.space_id, Action::Read)?;
    if post.deleted || post.locked || post.state == PostState::Archived {
        return Err("post reactions are closed".into());
    }
    let emoji = emoji.trim().to_string();
    let input_hash = normalized_input_hash(&format!("{post_id}\0{emoji}\0{active}"));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "set_post_reaction",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let key = post_reaction_key(post_id, ctx.sender(), &emoji);
    if active {
        if ctx.db.post_reaction().key().find(key.clone()).is_none() {
            ctx.db.post_reaction().insert(PostReaction {
                key,
                post_id,
                identity: ctx.sender(),
                emoji,
                created_at: ctx.timestamp,
            });
        }
    } else {
        ctx.db.post_reaction().key().delete(key);
    }
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "set_post_reaction",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_post_personal_state(
    ctx: &ReducerContext,
    post_id: Uuid,
    following: bool,
    bookmarked: bool,
    mark_read: bool,
) -> Result<(), String> {
    let post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    require_space_action(ctx, post.space_id, Action::Read)?;
    if post.deleted {
        return Err("deleted posts cannot be followed or bookmarked".into());
    }
    let key = post_identity_key(post_id, ctx.sender());
    let existing = ctx.db.post_user_state().key().find(key.clone());
    let last_read_sequence = if mark_read {
        post.activity_sequence
    } else {
        existing.as_ref().map_or(0, |row| row.last_read_sequence)
    };
    let row = PostUserState {
        key: key.clone(),
        post_id,
        identity: ctx.sender(),
        following,
        bookmarked,
        last_read_sequence,
        read_at: if mark_read {
            Some(ctx.timestamp)
        } else {
            existing.as_ref().and_then(|row| row.read_at)
        },
        updated_at: ctx.timestamp,
    };
    if existing.is_some() {
        ctx.db.post_user_state().key().update(row);
    } else {
        ctx.db.post_user_state().insert(row);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_post_pin(
    ctx: &ReducerContext,
    post_id: Uuid,
    pinned: bool,
    client_request_id: Uuid,
) -> Result<(), String> {
    let post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (_, member) = require_space_action(ctx, post.space_id, Action::ManageWorkspace)?;
    if !role_allows(member.role, Action::ManageWorkspace) || post.deleted {
        return Err("post pin update denied".into());
    }
    let input_hash = normalized_input_hash(&format!("{post_id}\0{pinned}"));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "set_post_pin",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    if pinned {
        let row = PostPin {
            post_id,
            workspace_id: post.workspace_id,
            space_id: post.space_id,
            pinned_by: ctx.sender(),
            pinned_at: ctx.timestamp,
        };
        if ctx.db.post_pin().post_id().find(post_id).is_some() {
            ctx.db.post_pin().post_id().update(row);
        } else {
            ctx.db.post_pin().insert(row);
        }
    } else {
        ctx.db.post_pin().post_id().delete(post_id);
    }
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "set_post_pin",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn configure_poll(ctx: &ReducerContext, input: ConfigurePollInput) -> Result<(), String> {
    let ConfigurePollInput {
        post_id,
        options,
        allows_multiple,
        expected_post_revision,
        client_request_id,
    } = input;
    if !(2..=20).contains(&options.len()) {
        return Err("polls require 2-20 options".into());
    }
    let mut labels = Vec::with_capacity(options.len());
    for option in options {
        validate_text(&option, "poll option", 200)?;
        let label = option.trim().to_string();
        if labels.contains(&label) {
            return Err("poll option labels must be unique".into());
        }
        labels.push(label);
    }
    let mut post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (_, member) = require_space_action(ctx, post.space_id, Action::Write)?;
    let is_admin = role_allows(member.role, Action::ManageWorkspace);
    if post.kind != PostKind::Poll
        || post.deleted
        || post.locked
        || post.state == PostState::Archived
        || (post.author_identity != ctx.sender()
            && post.owner_identity != ctx.sender()
            && !is_admin)
    {
        return Err("poll configuration denied".into());
    }
    let input_hash = normalized_input_hash(&format!(
        "{post_id}\0{labels:?}\0{allows_multiple}\0{expected_post_revision}"
    ));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "configure_poll",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    revision_matches(post.revision, expected_post_revision)?;
    if ctx
        .db
        .poll_vote()
        .post_id()
        .filter(post_id)
        .next()
        .is_some()
    {
        return Err("poll options cannot change after voting begins".into());
    }
    let option_ids: Vec<_> = ctx
        .db
        .poll_option()
        .post_id()
        .filter(post_id)
        .map(|row| row.id)
        .collect();
    for option_id in option_ids {
        ctx.db.poll_option().id().delete(option_id);
    }
    let existing = ctx.db.poll().post_id().find(post_id);
    let poll = Poll {
        post_id,
        workspace_id: post.workspace_id,
        space_id: post.space_id,
        allows_multiple,
        closed: false,
        revision: existing
            .as_ref()
            .map_or(1, |row| row.revision.saturating_add(1)),
        created_at: existing
            .as_ref()
            .map_or(ctx.timestamp, |row| row.created_at),
        updated_at: ctx.timestamp,
    };
    if existing.is_some() {
        ctx.db.poll().post_id().update(poll);
    } else {
        ctx.db.poll().insert(poll);
    }
    for (position, label) in labels.into_iter().enumerate() {
        ctx.db.poll_option().insert(PollOption {
            id: new_id(ctx)?,
            post_id,
            label,
            position: u32::try_from(position).map_err(|_| "poll option position overflow")?,
        });
    }
    post.revision = post.revision.saturating_add(1);
    post.updated_at = ctx.timestamp;
    append_post_activity(ctx, &mut post, "poll_configured", "Poll configured")?;
    ctx.db.post().id().update(post.clone());
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "configure_poll",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn cast_poll_vote(
    ctx: &ReducerContext,
    post_id: Uuid,
    option_ids: Vec<Uuid>,
    client_request_id: Uuid,
) -> Result<(), String> {
    let post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    require_space_action(ctx, post.space_id, Action::Read)?;
    let poll = ctx
        .db
        .poll()
        .post_id()
        .find(post_id)
        .ok_or_else(|| "poll is not configured".to_string())?;
    let mut selected = Vec::with_capacity(option_ids.len());
    for option_id in option_ids {
        if !selected.contains(&option_id) {
            selected.push(option_id);
        }
    }
    let all_options_valid = selected.iter().all(|option_id| {
        ctx.db
            .poll_option()
            .id()
            .find(*option_id)
            .is_some_and(|option| option.post_id == post_id)
    });
    if post.deleted
        || post.locked
        || post.state == PostState::Archived
        || !crate::policy::poll_selection_valid(
            !poll.closed,
            poll.allows_multiple,
            selected.len(),
            all_options_valid,
        )
    {
        return Err("poll vote is invalid or closed".into());
    }
    selected.sort_by_key(ToString::to_string);
    let input_hash = normalized_input_hash(&format!("{post_id}\0{selected:?}"));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "cast_poll_vote",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let prior_keys: Vec<_> = ctx
        .db
        .poll_vote()
        .identity()
        .filter(ctx.sender())
        .filter(|vote| vote.post_id == post_id)
        .map(|vote| vote.key)
        .collect();
    for key in prior_keys {
        ctx.db.poll_vote().key().delete(key);
    }
    for option_id in selected {
        ctx.db.poll_vote().insert(PollVote {
            key: poll_vote_key(post_id, option_id, ctx.sender()),
            post_id,
            option_id,
            identity: ctx.sender(),
            created_at: ctx.timestamp,
        });
    }
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "cast_poll_vote",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_poll_closed(
    ctx: &ReducerContext,
    post_id: Uuid,
    closed: bool,
    expected_poll_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let mut post = ctx
        .db
        .post()
        .id()
        .find(post_id)
        .ok_or_else(|| "post not found".to_string())?;
    let (_, member) = require_space_action(ctx, post.space_id, Action::Write)?;
    let is_admin = role_allows(member.role, Action::ManageWorkspace);
    if post.author_identity != ctx.sender() && post.owner_identity != ctx.sender() && !is_admin {
        return Err("poll close update denied".into());
    }
    if post.deleted || ((post.locked || post.state == PostState::Archived) && !is_admin) {
        return Err("poll close update denied in the current post state".into());
    }
    let mut poll = ctx
        .db
        .poll()
        .post_id()
        .find(post_id)
        .ok_or_else(|| "poll is not configured".to_string())?;
    revision_matches(poll.revision, expected_poll_revision)?;
    let input_hash =
        normalized_input_hash(&format!("{post_id}\0{closed}\0{expected_poll_revision}"));
    if existing_receipt(
        ctx,
        Some(post.workspace_id),
        "set_poll_closed",
        client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    poll.closed = closed;
    poll.revision = poll.revision.saturating_add(1);
    poll.updated_at = ctx.timestamp;
    ctx.db.poll().post_id().update(poll);
    append_post_activity(
        ctx,
        &mut post,
        if closed {
            "poll_closed"
        } else {
            "poll_reopened"
        },
        if closed {
            "Poll closed"
        } else {
            "Poll reopened"
        },
    )?;
    ctx.db.post().id().update(post.clone());
    insert_receipt(
        ctx,
        Some(post.workspace_id),
        "set_poll_closed",
        client_request_id,
        input_hash,
        "post",
        post.id,
    );
    Ok(())
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
    if post.deleted || post.locked || post.state == PostState::Archived {
        return Err("deleted, locked, or archived posts cannot receive new threads".into());
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
    let mut post = post;
    append_post_activity(ctx, &mut post, "thread_created", "Thread created")?;
    ctx.db.post().id().update(post.clone());
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
    let mut post = ctx
        .db
        .post()
        .id()
        .find(thread.root_post_id)
        .ok_or_else(|| "root post not found".to_string())?;
    if post.deleted || post.locked || post.state == PostState::Archived {
        return Err("root post is unavailable for thread updates".into());
    }
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
    append_post_activity(ctx, &mut post, "thread_updated", "Thread updated")?;
    ctx.db.post().id().update(post);
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
    let mut root_post = ctx
        .db
        .post()
        .id()
        .find(thread.root_post_id)
        .ok_or_else(|| "root post not found".to_string())?;
    if root_post.deleted || root_post.locked || root_post.state == PostState::Archived {
        return Err("root post is not accepting contributions".into());
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
    append_post_activity(
        ctx,
        &mut root_post,
        "contribution_added",
        "Thread contribution added",
    )?;
    ctx.db.post().id().update(root_post);
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
    let post = ctx
        .db
        .post()
        .id()
        .find(thread.root_post_id)
        .ok_or_else(|| "root post not found".to_string())?;
    if post.deleted || post.locked || post.state == PostState::Archived {
        return Err("root post is not accepting contribution changes".into());
    }
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
    let mut post = ctx
        .db
        .post()
        .id()
        .find(thread.root_post_id)
        .ok_or_else(|| "root post not found".to_string())?;
    append_post_activity(
        ctx,
        &mut post,
        "contribution_edited",
        "Thread contribution edited",
    )?;
    ctx.db.post().id().update(post);
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
    let mut post = ctx
        .db
        .post()
        .id()
        .find(thread.root_post_id)
        .ok_or_else(|| "root post not found".to_string())?;
    append_post_activity(
        ctx,
        &mut post,
        "contribution_deleted",
        "Thread contribution deleted",
    )?;
    ctx.db.post().id().update(post);
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

fn direct_participant_key(conversation_id: Uuid, identity: Identity) -> String {
    format!("{conversation_id}:{identity}")
}

fn direct_sequence_key(conversation_id: Uuid, sequence: u64) -> String {
    format!("{conversation_id}:{sequence:020}")
}

fn direct_ancestry_key(ancestor_id: Uuid, descendant_id: Uuid) -> String {
    format!("{ancestor_id}:{descendant_id}")
}

fn direct_read_key(conversation_id: Uuid, identity: Identity) -> String {
    format!("{conversation_id}:{identity}")
}

fn dm_promotion_source_key(proposal_id: Uuid, ordinal: u32) -> String {
    format!("{proposal_id}:{ordinal:03}")
}

fn dm_promotion_consent_key(proposal_id: Uuid, identity: Identity) -> String {
    format!("{proposal_id}:{identity}")
}

fn identity_is_active_human_member(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    identity: Identity,
) -> bool {
    ctx.db
        .user()
        .identity()
        .find(identity)
        .is_some_and(|user| !user.disabled)
        && ctx
            .db
            .service_principal()
            .identity()
            .find(identity)
            .is_none()
        && find_membership(ctx, workspace_id, identity).is_some_and(|member| member.active)
}

fn direct_participant_is_active(
    ctx: &ReducerContext,
    conversation: &DirectConversation,
    identity: Identity,
) -> bool {
    ctx.db
        .direct_participant()
        .key()
        .find(direct_participant_key(conversation.id, identity))
        .is_some_and(|participant| participant.left_at.is_none())
        && identity_is_active_human_member(ctx, conversation.workspace_id, identity)
}

fn require_direct_access(
    ctx: &ReducerContext,
    conversation_id: Uuid,
) -> Result<DirectConversation, String> {
    require_registered_user(ctx)?;
    let conversation = ctx
        .db
        .direct_conversation()
        .id()
        .find(conversation_id)
        .ok_or_else(|| "direct conversation unavailable".to_string())?;
    let workspace_active = can_read_workspace(ctx, conversation.workspace_id, ctx.sender());
    let participant_active = ctx
        .db
        .direct_participant()
        .key()
        .find(direct_participant_key(conversation.id, ctx.sender()))
        .is_some_and(|participant| participant.left_at.is_none());
    let user_enabled = ctx
        .db
        .user()
        .identity()
        .find(ctx.sender())
        .is_some_and(|user| !user.disabled)
        && ctx
            .db
            .service_principal()
            .identity()
            .find(ctx.sender())
            .is_none();
    if !crate::policy::direct_access_allowed(workspace_active, participant_active, user_enabled) {
        return Err("direct conversation unavailable".into());
    }
    Ok(conversation)
}

fn require_direct_write(
    ctx: &ReducerContext,
    conversation_id: Uuid,
) -> Result<DirectConversation, String> {
    let conversation = require_direct_access(ctx, conversation_id)?;
    if !crate::policy::direct_write_allowed(true, conversation.deactivated_at.is_some()) {
        return Err("direct conversation is deactivated".into());
    }
    Ok(conversation)
}

fn active_direct_participants(
    ctx: &ReducerContext,
    conversation: &DirectConversation,
) -> Vec<DirectParticipant> {
    ctx.db
        .direct_participant()
        .conversation_id()
        .filter(conversation.id)
        .filter(|participant| {
            participant.left_at.is_none()
                && identity_is_active_human_member(
                    ctx,
                    conversation.workspace_id,
                    participant.identity,
                )
        })
        .collect()
}

fn direct_participant_epoch_hash(participants: &[DirectParticipant]) -> String {
    let mut bindings = participants
        .iter()
        .map(|participant| format!("{}:{}", participant.identity, participant.participant_epoch))
        .collect::<Vec<_>>();
    bindings.sort();
    normalized_input_hash(&bindings.join("\0"))
}

fn dm_source_revision_hash(sources: &[(Uuid, u64)]) -> String {
    normalized_input_hash(
        &sources
            .iter()
            .enumerate()
            .map(|(ordinal, (message_id, revision))| format!("{ordinal}:{message_id}:{revision}"))
            .collect::<Vec<_>>()
            .join("\0"),
    )
}

fn identity_can_write_space(ctx: &ReducerContext, space: &Space, identity: Identity) -> bool {
    !space.archived
        && identity_is_active_human_member(ctx, space.workspace_id, identity)
        && find_membership(ctx, space.workspace_id, identity)
            .is_some_and(|member| role_allows(member.role, Action::Write))
        && can_read_space(ctx, space, identity)
}

fn cancel_pending_dm_promotions(ctx: &ReducerContext, conversation_id: Uuid) {
    for mut proposal in ctx
        .db
        .dm_promotion_proposal()
        .conversation_id()
        .filter(conversation_id)
        .filter(|proposal| proposal.state == DmPromotionState::Pending)
    {
        proposal.state = DmPromotionState::Canceled;
        proposal.revision = proposal.revision.saturating_add(1);
        proposal.updated_at = ctx.timestamp;
        ctx.db.dm_promotion_proposal().id().update(proposal);
    }
}

fn deactivate_direct_participant(ctx: &ReducerContext, conversation_id: Uuid, identity: Identity) {
    let key = direct_participant_key(conversation_id, identity);
    if let Some(mut participant) = ctx.db.direct_participant().key().find(key)
        && participant.left_at.is_none()
    {
        participant.left_at = Some(ctx.timestamp);
        participant.participant_epoch = participant.participant_epoch.saturating_add(1);
        ctx.db.direct_participant().key().update(participant);
    }
    if let Some(mut conversation) = ctx.db.direct_conversation().id().find(conversation_id) {
        if active_direct_participants(ctx, &conversation).len() < 2 {
            conversation.deactivated_at.get_or_insert(ctx.timestamp);
        }
        conversation.revision = conversation.revision.saturating_add(1);
        conversation.updated_at = ctx.timestamp;
        ctx.db.direct_conversation().id().update(conversation);
    }
    cancel_pending_dm_promotions(ctx, conversation_id);
}

fn deactivate_direct_participation(ctx: &ReducerContext, workspace_id: Uuid, identity: Identity) {
    let conversation_ids: Vec<_> = ctx
        .db
        .direct_participant()
        .identity()
        .filter(identity)
        .filter(|participant| {
            participant.workspace_id == workspace_id && participant.left_at.is_none()
        })
        .map(|participant| participant.conversation_id)
        .collect();
    for conversation_id in conversation_ids {
        deactivate_direct_participant(ctx, conversation_id, identity);
    }
}

fn insert_direct_ancestry(
    ctx: &ReducerContext,
    conversation_id: Uuid,
    message_id: Uuid,
    parent_message_id: Option<Uuid>,
) -> Result<(), String> {
    ctx.db.direct_reply_ancestry().insert(DirectReplyAncestry {
        key: direct_ancestry_key(message_id, message_id),
        ancestor_message_id: message_id,
        descendant_message_id: message_id,
        conversation_id,
        depth: 0,
    });
    if let Some(parent_id) = parent_message_id {
        let parent = ctx
            .db
            .direct_message()
            .id()
            .find(parent_id)
            .filter(|message| message.conversation_id == conversation_id && !message.deleted)
            .ok_or_else(|| "direct reply parent unavailable".to_string())?;
        let ancestors: Vec<_> = ctx
            .db
            .direct_reply_ancestry()
            .descendant_message_id()
            .filter(parent.id)
            .collect();
        let parent_depth = ancestors.iter().map(|row| row.depth).max().unwrap_or(0);
        if !crate::policy::reply_depth_allowed(parent_depth, MAX_REPLY_DEPTH) {
            return Err("maximum direct reply depth exceeded".into());
        }
        for ancestor in ancestors {
            ctx.db.direct_reply_ancestry().insert(DirectReplyAncestry {
                key: direct_ancestry_key(ancestor.ancestor_message_id, message_id),
                ancestor_message_id: ancestor.ancestor_message_id,
                descendant_message_id: message_id,
                conversation_id,
                depth: ancestor.depth.saturating_add(1),
            });
        }
    }
    Ok(())
}

fn advance_direct_read_state(
    ctx: &ReducerContext,
    conversation_id: Uuid,
    identity: Identity,
    sequence: u64,
) {
    let key = direct_read_key(conversation_id, identity);
    if let Some(mut row) = ctx.db.direct_read_state().key().find(key.clone()) {
        row.last_read_sequence = sequence;
        row.updated_at = ctx.timestamp;
        ctx.db.direct_read_state().key().update(row);
    } else {
        ctx.db.direct_read_state().insert(DirectReadState {
            key,
            conversation_id,
            identity,
            last_read_sequence: sequence,
            updated_at: ctx.timestamp,
        });
    }
}

#[spacetimedb::reducer]
pub fn create_direct_conversation(
    ctx: &ReducerContext,
    input: CreateDirectConversationInput,
) -> Result<(), String> {
    require_registered_user(ctx)?;
    let mut participants = input.participants;
    participants.sort_by_key(ToString::to_string);
    let participant_hash_input = participants
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\0");
    let input_hash =
        normalized_input_hash(&format!("{}\0{participant_hash_input}", input.workspace_id));
    if existing_receipt(
        ctx,
        Some(input.workspace_id),
        "create_direct_conversation",
        input.client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    require_workspace_action(ctx, input.workspace_id, Action::Write)?;
    let unique = participants.windows(2).all(|window| window[0] != window[1]);
    let includes_caller = participants.contains(&ctx.sender());
    let every_active_human = participants
        .iter()
        .all(|identity| identity_is_active_human_member(ctx, input.workspace_id, *identity));
    if !crate::policy::direct_participant_set_valid(
        participants.len(),
        unique,
        includes_caller,
        every_active_human,
    ) {
        return Err("direct conversations require 2 to 8 unique active human participants including the caller".into());
    }
    let conversation_id = new_id(ctx)?;
    ctx.db.direct_conversation().insert(DirectConversation {
        id: conversation_id,
        workspace_id: input.workspace_id,
        created_by: ctx.sender(),
        next_sequence: 1,
        revision: 1,
        deactivated_at: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    for identity in participants {
        ctx.db.direct_participant().insert(DirectParticipant {
            key: direct_participant_key(conversation_id, identity),
            conversation_id,
            identity,
            workspace_id: input.workspace_id,
            joined_at: ctx.timestamp,
            left_at: None,
            participant_epoch: 1,
        });
        ctx.db.direct_read_state().insert(DirectReadState {
            key: direct_read_key(conversation_id, identity),
            conversation_id,
            identity,
            last_read_sequence: 0,
            updated_at: ctx.timestamp,
        });
    }
    insert_receipt(
        ctx,
        Some(input.workspace_id),
        "create_direct_conversation",
        input.client_request_id,
        input_hash,
        "direct_conversation",
        conversation_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: input.workspace_id,
            action: "create_direct_conversation",
            resource_type: "direct_conversation",
            resource_id: conversation_id,
            request_id: input.client_request_id,
            effective_principal: "human",
            summary: "private conversation created",
        },
    )
}

#[spacetimedb::reducer]
pub fn send_direct_message(
    ctx: &ReducerContext,
    conversation_id: Uuid,
    parent_message_id: Option<Uuid>,
    body: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash =
        normalized_input_hash(&format!("{conversation_id}\0{parent_message_id:?}\0{body}"));
    if existing_private_receipt(
        ctx,
        "send_direct_message",
        client_request_id,
        &input_hash,
        "direct conversation unavailable",
    )? {
        return Ok(());
    }
    if crate::policy::direct_messages_are_searchable() {
        return Err("direct messages must remain outside search".into());
    }
    validate_text(&body, "direct message body", 50_000)?;
    let mut conversation = require_direct_write(ctx, conversation_id)?;
    let message_id = new_id(ctx)?;
    let sequence = conversation.next_sequence;
    insert_direct_ancestry(ctx, conversation_id, message_id, parent_message_id)?;
    ctx.db.direct_message().insert(DirectMessage {
        id: message_id,
        sequence_key: direct_sequence_key(conversation_id, sequence),
        conversation_id,
        author_identity: ctx.sender(),
        workspace_id: conversation.workspace_id,
        sequence,
        parent_message_id,
        body,
        revision: 1,
        deleted: false,
        created_at: ctx.timestamp,
        edited_at: None,
        deleted_at: None,
    });
    conversation.next_sequence = conversation.next_sequence.saturating_add(1);
    conversation.revision = conversation.revision.saturating_add(1);
    conversation.updated_at = ctx.timestamp;
    ctx.db
        .direct_conversation()
        .id()
        .update(conversation.clone());
    advance_direct_read_state(ctx, conversation_id, ctx.sender(), sequence);
    insert_private_receipt(
        ctx,
        conversation.workspace_id,
        "send_direct_message",
        client_request_id,
        input_hash,
        "direct_message",
        message_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: conversation.workspace_id,
            action: "send_direct_message",
            resource_type: "direct_message",
            resource_id: message_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "private message created",
        },
    )
}

fn load_direct_message_author(
    ctx: &ReducerContext,
    message_id: Uuid,
    operation: crate::policy::PrivateDirectMessageOperation,
) -> Result<(DirectConversation, DirectMessage), String> {
    let message = ctx
        .db
        .direct_message()
        .id()
        .find(message_id)
        .ok_or_else(|| {
            direct_message_target_error(
                operation,
                crate::policy::PrivateDirectMessageTarget::Nonexistent,
            )
        })?;
    if !crate::policy::direct_resource_lookup_allowed(true, message.author_identity == ctx.sender())
    {
        return Err(direct_message_target_error(
            operation,
            crate::policy::PrivateDirectMessageTarget::OtherAuthor,
        ));
    }
    let conversation = ctx
        .db
        .direct_conversation()
        .id()
        .find(message.conversation_id)
        .ok_or_else(|| {
            direct_message_target_error(
                operation,
                crate::policy::PrivateDirectMessageTarget::Nonexistent,
            )
        })?;
    Ok((conversation, message))
}

fn direct_message_target_error(
    operation: crate::policy::PrivateDirectMessageOperation,
    target: crate::policy::PrivateDirectMessageTarget,
) -> String {
    crate::policy::direct_message_target_gate(operation, target)
        .expect_err("only unavailable direct-message targets produce an error")
        .to_string()
}

#[spacetimedb::reducer]
pub fn edit_direct_message(
    ctx: &ReducerContext,
    message_id: Uuid,
    body: String,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!("{message_id}\0{body}\0{expected_revision}"));
    let operation = crate::policy::PrivateDirectMessageOperation::Edit;
    if existing_direct_message_receipt(ctx, operation, client_request_id, &input_hash)? {
        return Ok(());
    }
    validate_text(&body, "direct message body", 50_000)?;
    let (conversation, mut message) = load_direct_message_author(ctx, message_id, operation)?;
    require_direct_write(ctx, conversation.id).map_err(|_| {
        direct_message_target_error(
            operation,
            crate::policy::PrivateDirectMessageTarget::AccessRevoked,
        )
    })?;
    if !crate::policy::direct_message_mutation_allowed(
        true,
        true,
        message.revision == expected_revision,
        message.deleted,
    ) {
        return Err("direct message mutation denied or stale".into());
    }
    message.body = body;
    message.revision = message.revision.saturating_add(1);
    message.edited_at = Some(ctx.timestamp);
    ctx.db.direct_message().id().update(message);
    insert_private_receipt(
        ctx,
        conversation.workspace_id,
        "edit_direct_message",
        client_request_id,
        input_hash,
        "direct_message",
        message_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: conversation.workspace_id,
            action: "edit_direct_message",
            resource_type: "direct_message",
            resource_id: message_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "private message edited",
        },
    )
}

#[spacetimedb::reducer]
pub fn delete_direct_message(
    ctx: &ReducerContext,
    message_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!("{message_id}\0{expected_revision}"));
    let operation = crate::policy::PrivateDirectMessageOperation::Delete;
    if existing_direct_message_receipt(ctx, operation, client_request_id, &input_hash)? {
        return Ok(());
    }
    let (conversation, mut message) = load_direct_message_author(ctx, message_id, operation)?;
    require_direct_write(ctx, conversation.id).map_err(|_| {
        direct_message_target_error(
            operation,
            crate::policy::PrivateDirectMessageTarget::AccessRevoked,
        )
    })?;
    if !crate::policy::direct_message_mutation_allowed(
        true,
        true,
        message.revision == expected_revision,
        message.deleted,
    ) {
        return Err("direct message mutation denied or stale".into());
    }
    message.body.clear();
    message.deleted = true;
    message.revision = message.revision.saturating_add(1);
    message.deleted_at = Some(ctx.timestamp);
    ctx.db.direct_message().id().update(message);
    insert_private_receipt(
        ctx,
        conversation.workspace_id,
        "delete_direct_message",
        client_request_id,
        input_hash,
        "direct_message",
        message_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: conversation.workspace_id,
            action: "delete_direct_message",
            resource_type: "direct_message",
            resource_id: message_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "private message deleted",
        },
    )
}

#[spacetimedb::reducer]
pub fn mark_direct_read(
    ctx: &ReducerContext,
    conversation_id: Uuid,
    last_read_sequence: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!("{conversation_id}\0{last_read_sequence}"));
    if existing_private_receipt(
        ctx,
        "mark_direct_read",
        client_request_id,
        &input_hash,
        "direct conversation unavailable",
    )? {
        return Ok(());
    }
    let conversation = require_direct_access(ctx, conversation_id)?;
    let current = ctx
        .db
        .direct_read_state()
        .key()
        .find(direct_read_key(conversation_id, ctx.sender()))
        .map_or(0, |row| row.last_read_sequence);
    let maximum = conversation.next_sequence.saturating_sub(1);
    if !crate::policy::direct_read_advance_allowed(current, last_read_sequence, maximum) {
        return Err("direct read cursor cannot regress or exceed the append sequence".into());
    }
    advance_direct_read_state(ctx, conversation_id, ctx.sender(), last_read_sequence);
    insert_private_receipt(
        ctx,
        conversation.workspace_id,
        "mark_direct_read",
        client_request_id,
        input_hash,
        "direct_read_state",
        conversation_id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn leave_direct_conversation(
    ctx: &ReducerContext,
    conversation_id: Uuid,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&conversation_id.to_string());
    if existing_private_receipt(
        ctx,
        "leave_direct_conversation",
        client_request_id,
        &input_hash,
        "direct conversation unavailable",
    )? {
        return Ok(());
    }
    let conversation = ctx
        .db
        .direct_conversation()
        .id()
        .find(conversation_id)
        .ok_or_else(|| "direct conversation unavailable".to_string())?;
    if !direct_participant_is_active(ctx, &conversation, ctx.sender()) {
        return Err("direct conversation unavailable".into());
    }
    deactivate_direct_participant(ctx, conversation_id, ctx.sender());
    insert_private_receipt(
        ctx,
        conversation.workspace_id,
        "leave_direct_conversation",
        client_request_id,
        input_hash,
        "direct_conversation",
        conversation_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: conversation.workspace_id,
            action: "leave_direct_conversation",
            resource_type: "direct_conversation",
            resource_id: conversation_id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "private conversation access ended",
        },
    )
}

#[spacetimedb::reducer]
pub fn propose_dm_promotion(
    ctx: &ReducerContext,
    input: ProposeDmPromotionInput,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!(
        "{}\0{}\0{}\0{}\0{:?}\0{}",
        input.conversation_id,
        input.destination_space_id,
        input.title.trim(),
        input.body,
        input.source_message_ids,
        input.expires_in_seconds,
    ));
    if existing_private_receipt(
        ctx,
        "propose_dm_promotion",
        input.client_request_id,
        &input_hash,
        "promotion unavailable",
    )? {
        return Ok(());
    }
    validate_text(&input.title, "promotion title", 200)?;
    validate_text(&input.body, "promotion body", 50_000)?;
    if !(60..=604_800).contains(&input.expires_in_seconds) {
        return Err("promotion expiry must be between 60 seconds and 7 days".into());
    }
    if input.source_message_ids.is_empty() || input.source_message_ids.len() > 100 {
        return Err("promotion requires between 1 and 100 source messages".into());
    }
    let conversation = require_direct_write(ctx, input.conversation_id)
        .map_err(|_| "promotion unavailable".to_string())?;
    let destination = ctx
        .db
        .space()
        .id()
        .find(input.destination_space_id)
        .filter(|space| space.workspace_id == conversation.workspace_id)
        .ok_or_else(|| "promotion destination unavailable".to_string())?;
    let participants = active_direct_participants(ctx, &conversation);
    if participants.len() < 2
        || !identity_can_write_space(ctx, &destination, ctx.sender())
        || participants
            .iter()
            .any(|participant| !can_read_space(ctx, &destination, participant.identity))
    {
        return Err("promotion destination is not authorized for every active participant".into());
    }
    let mut seen_sources = Vec::new();
    let mut source_revisions = Vec::new();
    for message_id in &input.source_message_ids {
        if seen_sources.contains(message_id) {
            return Err("promotion source messages must be unique".into());
        }
        seen_sources.push(*message_id);
        let message = ctx
            .db
            .direct_message()
            .id()
            .find(*message_id)
            .filter(|message| message.conversation_id == conversation.id && !message.deleted)
            .ok_or_else(|| "promotion source unavailable".to_string())?;
        if !participants
            .iter()
            .any(|participant| participant.identity == message.author_identity)
        {
            return Err("promotion source author is no longer an active participant".into());
        }
        source_revisions.push((message.id, message.revision));
    }
    let title = input.title.trim().to_string();
    let draft_hash = normalized_input_hash(&format!("{title}\0{}", input.body));
    let source_revision_hash = dm_source_revision_hash(&source_revisions);
    let participant_epoch_hash = direct_participant_epoch_hash(&participants);
    let proposal_hash = normalized_input_hash(&format!(
        "{}\0{}\0{draft_hash}\0{source_revision_hash}\0{participant_epoch_hash}",
        conversation.id, destination.id
    ));
    let proposal_id = new_id(ctx)?;
    ctx.db.dm_promotion_proposal().insert(DmPromotionProposal {
        id: proposal_id,
        conversation_id: conversation.id,
        workspace_id: conversation.workspace_id,
        destination_space_id: destination.id,
        proposer_identity: ctx.sender(),
        title,
        body: input.body,
        draft_hash,
        source_revision_hash,
        proposal_hash,
        participant_epoch_hash,
        state: DmPromotionState::Pending,
        revision: 1,
        expires_at: ctx.timestamp
            + TimeDuration::from_micros(i64::from(input.expires_in_seconds) * 1_000_000),
        finalized_post_id: None,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    for (ordinal, (message_id, message_revision)) in source_revisions.into_iter().enumerate() {
        let ordinal = u32::try_from(ordinal).map_err(|_| "too many promotion sources")?;
        ctx.db.dm_promotion_source().insert(DmPromotionSource {
            key: dm_promotion_source_key(proposal_id, ordinal),
            proposal_id,
            message_id,
            message_revision,
            ordinal,
        });
    }
    insert_private_receipt(
        ctx,
        conversation.workspace_id,
        "propose_dm_promotion",
        input.client_request_id,
        input_hash,
        "dm_promotion",
        proposal_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: conversation.workspace_id,
            action: "propose_dm_promotion",
            resource_type: "dm_promotion",
            resource_id: proposal_id,
            request_id: input.client_request_id,
            effective_principal: "human",
            summary: "private promotion proposed",
        },
    )
}

#[spacetimedb::reducer]
pub fn decide_dm_promotion(
    ctx: &ReducerContext,
    proposal_id: Uuid,
    approve: bool,
    expected_proposal_hash: String,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!(
        "{proposal_id}\0{approve}\0{expected_proposal_hash}"
    ));
    if existing_private_receipt(
        ctx,
        "decide_dm_promotion",
        client_request_id,
        &input_hash,
        "promotion unavailable",
    )? {
        return Ok(());
    }
    let mut proposal = ctx
        .db
        .dm_promotion_proposal()
        .id()
        .find(proposal_id)
        .ok_or_else(|| "promotion unavailable".to_string())?;
    require_direct_access(ctx, proposal.conversation_id)
        .map_err(|_| "promotion unavailable".to_string())?;
    if proposal.state != DmPromotionState::Pending
        || proposal.expires_at <= ctx.timestamp
        || proposal.proposal_hash != expected_proposal_hash
    {
        return Err("promotion decision is stale or unavailable".into());
    }
    let key = dm_promotion_consent_key(proposal_id, ctx.sender());
    if ctx
        .db
        .dm_promotion_consent()
        .key()
        .find(key.clone())
        .is_some()
    {
        return Err("promotion consent is immutable".into());
    }
    let decision = if approve {
        DmPromotionDecision::Approve
    } else {
        DmPromotionDecision::Reject
    };
    ctx.db.dm_promotion_consent().insert(DmPromotionConsent {
        key,
        proposal_id,
        identity: ctx.sender(),
        decision,
        proposal_hash: proposal.proposal_hash.clone(),
        decided_at: ctx.timestamp,
    });
    if !approve {
        proposal.state = DmPromotionState::Rejected;
        proposal.revision = proposal.revision.saturating_add(1);
        proposal.updated_at = ctx.timestamp;
        ctx.db.dm_promotion_proposal().id().update(proposal.clone());
    }
    insert_private_receipt(
        ctx,
        proposal.workspace_id,
        "decide_dm_promotion",
        client_request_id,
        input_hash,
        "dm_promotion",
        proposal_id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn cancel_dm_promotion(
    ctx: &ReducerContext,
    proposal_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!("{proposal_id}\0{expected_revision}"));
    if existing_private_receipt(
        ctx,
        "cancel_dm_promotion",
        client_request_id,
        &input_hash,
        "promotion unavailable",
    )? {
        return Ok(());
    }
    let mut proposal = ctx
        .db
        .dm_promotion_proposal()
        .id()
        .find(proposal_id)
        .ok_or_else(|| "promotion unavailable".to_string())?;
    require_direct_access(ctx, proposal.conversation_id)
        .map_err(|_| "promotion unavailable".to_string())?;
    if proposal.proposer_identity != ctx.sender() || proposal.state != DmPromotionState::Pending {
        return Err("promotion cancellation denied".into());
    }
    revision_matches(proposal.revision, expected_revision)?;
    proposal.state = DmPromotionState::Canceled;
    proposal.revision = proposal.revision.saturating_add(1);
    proposal.updated_at = ctx.timestamp;
    ctx.db.dm_promotion_proposal().id().update(proposal.clone());
    insert_private_receipt(
        ctx,
        proposal.workspace_id,
        "cancel_dm_promotion",
        client_request_id,
        input_hash,
        "dm_promotion",
        proposal_id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn expire_dm_promotion(
    ctx: &ReducerContext,
    proposal_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!("{proposal_id}\0{expected_revision}"));
    if existing_private_receipt(
        ctx,
        "expire_dm_promotion",
        client_request_id,
        &input_hash,
        "promotion unavailable",
    )? {
        return Ok(());
    }
    let mut proposal = ctx
        .db
        .dm_promotion_proposal()
        .id()
        .find(proposal_id)
        .ok_or_else(|| "promotion unavailable".to_string())?;
    require_direct_access(ctx, proposal.conversation_id)
        .map_err(|_| "promotion unavailable".to_string())?;
    revision_matches(proposal.revision, expected_revision)?;
    if proposal.state != DmPromotionState::Pending || proposal.expires_at > ctx.timestamp {
        return Err("promotion is not eligible for expiry".into());
    }
    proposal.state = DmPromotionState::Expired;
    proposal.revision = proposal.revision.saturating_add(1);
    proposal.updated_at = ctx.timestamp;
    ctx.db.dm_promotion_proposal().id().update(proposal.clone());
    insert_private_receipt(
        ctx,
        proposal.workspace_id,
        "expire_dm_promotion",
        client_request_id,
        input_hash,
        "dm_promotion",
        proposal_id,
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn finalize_dm_promotion(
    ctx: &ReducerContext,
    proposal_id: Uuid,
    expected_revision: u64,
    client_request_id: Uuid,
) -> Result<(), String> {
    let input_hash = normalized_input_hash(&format!("{proposal_id}\0{expected_revision}"));
    if existing_private_receipt(
        ctx,
        "finalize_dm_promotion",
        client_request_id,
        &input_hash,
        "promotion unavailable",
    )? {
        return Ok(());
    }
    let mut proposal = ctx
        .db
        .dm_promotion_proposal()
        .id()
        .find(proposal_id)
        .ok_or_else(|| "promotion unavailable".to_string())?;
    let conversation = require_direct_write(ctx, proposal.conversation_id)
        .map_err(|_| "promotion unavailable".to_string())?;
    let participants = active_direct_participants(ctx, &conversation);
    let participant_epoch_matches =
        direct_participant_epoch_hash(&participants) == proposal.participant_epoch_hash;
    let unanimous_approval = !participants.is_empty()
        && participants.iter().all(|participant| {
            ctx.db
                .dm_promotion_consent()
                .key()
                .find(dm_promotion_consent_key(proposal.id, participant.identity))
                .is_some_and(|consent| {
                    consent.decision == DmPromotionDecision::Approve
                        && consent.proposal_hash == proposal.proposal_hash
                })
        });
    let mut sources: Vec<_> = ctx
        .db
        .dm_promotion_source()
        .proposal_id()
        .filter(proposal.id)
        .collect();
    sources.sort_by_key(|source| source.ordinal);
    let source_bindings = sources
        .iter()
        .map(|source| (source.message_id, source.message_revision))
        .collect::<Vec<_>>();
    let sources_match = !sources.is_empty()
        && dm_source_revision_hash(&source_bindings) == proposal.source_revision_hash
        && sources.iter().all(|source| {
            ctx.db
                .direct_message()
                .id()
                .find(source.message_id)
                .is_some_and(|message| {
                    message.conversation_id == proposal.conversation_id
                        && message.revision == source.message_revision
                        && !message.deleted
                        && participants
                            .iter()
                            .any(|participant| participant.identity == message.author_identity)
                })
        });
    let destination = ctx
        .db
        .space()
        .id()
        .find(proposal.destination_space_id)
        .filter(|space| space.workspace_id == proposal.workspace_id);
    let destination_authorized = destination.as_ref().is_some_and(|space| {
        identity_can_write_space(ctx, space, proposal.proposer_identity)
            && participants
                .iter()
                .all(|participant| can_read_space(ctx, space, participant.identity))
    });
    if proposal.revision != expected_revision
        || !crate::policy::direct_promotion_finalize_allowed(
            proposal.state == DmPromotionState::Pending,
            proposal.expires_at > ctx.timestamp,
            participant_epoch_matches,
            unanimous_approval,
            sources_match,
            destination_authorized,
            proposal.finalized_post_id.is_none(),
        )
    {
        return Err("promotion finalization is stale or unauthorized".into());
    }
    let destination = destination.ok_or_else(|| "promotion destination unavailable".to_string())?;
    let post_id = new_id(ctx)?;
    let post = Post {
        id: post_id,
        workspace_id: proposal.workspace_id,
        space_id: destination.id,
        author_identity: proposal.proposer_identity,
        owner_identity: proposal.proposer_identity,
        assignee_identity: None,
        kind: PostKind::Discussion,
        state: PostState::Active,
        locked: false,
        title: proposal.title.clone(),
        body: proposal.body.clone(),
        revision: 1,
        activity_sequence: 1,
        last_activity_at: ctx.timestamp,
        deleted: false,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    };
    ctx.db.post().insert(post.clone());
    ctx.db.post_activity().insert(PostActivity {
        key: post_activity_key(post_id, 1),
        post_id,
        sequence: 1,
        actor_identity: proposal.proposer_identity,
        kind: "created".into(),
        summary: "Post created".into(),
        created_at: ctx.timestamp,
    });
    ctx.db.post_user_state().insert(PostUserState {
        key: post_identity_key(post_id, proposal.proposer_identity),
        post_id,
        identity: proposal.proposer_identity,
        following: true,
        bookmarked: false,
        last_read_sequence: 1,
        read_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
    });
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
            tombstone: false,
        },
    )?;
    proposal.state = DmPromotionState::Finalized;
    proposal.finalized_post_id = Some(post_id);
    proposal.revision = proposal.revision.saturating_add(1);
    proposal.updated_at = ctx.timestamp;
    ctx.db.dm_promotion_proposal().id().update(proposal.clone());
    insert_private_receipt(
        ctx,
        proposal.workspace_id,
        "finalize_dm_promotion",
        client_request_id,
        input_hash,
        "post",
        post_id,
    );
    audit(
        ctx,
        AuditInput {
            workspace_id: proposal.workspace_id,
            action: "finalize_dm_promotion",
            resource_type: "dm_promotion",
            resource_id: proposal.id,
            request_id: client_request_id,
            effective_principal: "human",
            summary: "private promotion finalized",
        },
    )
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
    coalesce_notification(
        ctx,
        NotificationIntent {
            workspace_id,
            space_id: thread_id.and_then(|thread_id| {
                ctx.db
                    .named_thread()
                    .id()
                    .find(thread_id)
                    .map(|thread| thread.space_id)
            }),
            recipient_identity: assignee.identity,
            kind: NotificationKind::Assignment,
            resource_type: "task",
            resource_id: id,
            summary: "You were assigned a task",
        },
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
        OutboxInsert {
            workspace_id: file.workspace_id,
            kind: JOB_FILE_SCAN,
            resource_type: "file",
            resource_id: file.id,
            resource_revision: file.revision,
            effect_key: format!("file:{file_id}:scan:{}", file.revision),
            payload: OutboxSemanticPayload {
                file_id: Some(file.id),
                version: Some(file.revision),
                ..Default::default()
            },
        },
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
    validate_file_job_lease(ctx, job_id, lease_generation, &file, "file.scan")?;
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
            OutboxInsert {
                workspace_id: file.workspace_id,
                kind: JOB_FILE_EXTRACT,
                resource_type: "file",
                resource_id: file.id,
                resource_revision: file.revision,
                effect_key: format!("file:{file_id}:extract:{}", file.revision),
                payload: OutboxSemanticPayload {
                    file_id: Some(file.id),
                    version: Some(file.revision),
                    ..Default::default()
                },
            },
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
    validate_file_job_lease(ctx, job_id, lease_generation, &file, "file.extract")?;
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
        OutboxInsert {
            workspace_id: file.workspace_id,
            kind: JOB_FILE_CLEANUP,
            resource_type: "file",
            resource_id: file.id,
            resource_revision: file.revision,
            effect_key: format!("file:{file_id}:cleanup:{}", file.revision),
            payload: OutboxSemanticPayload {
                file_id: Some(file.id),
                version: Some(file.revision),
                ..Default::default()
            },
        },
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
pub fn heartbeat_presence(
    ctx: &ReducerContext,
    input: HeartbeatPresenceInput,
) -> Result<(), String> {
    require_workspace_action(ctx, input.workspace_id, Action::Read)?;
    if !crate::policy::presence_heartbeat_valid(input.ttl_seconds, &input.device_label) {
        return Err("presence heartbeat metadata or ttl is invalid".into());
    }
    if crate::policy::presence_authorizes(true) {
        return Err("presence must never grant authorization".into());
    }
    let scope_key = presence_scope_key(input.workspace_id, ctx.sender());
    let expired_keys: Vec<_> = ctx
        .db
        .presence_session()
        .scope_key()
        .filter(&scope_key)
        .filter(|session| session.expires_at <= ctx.timestamp)
        .map(|session| session.key)
        .collect();
    for expired_key in expired_keys {
        remove_presence_session(ctx, &expired_key);
    }
    let key = presence_session_key(input.workspace_id, ctx.sender(), input.session_id);
    let expires_at =
        ctx.timestamp + TimeDuration::from_micros(i64::from(input.ttl_seconds) * 1_000_000);
    if let Some(mut session) = ctx.db.presence_session().key().find(key.clone()) {
        session.device_kind = input.device_kind;
        session.device_label = input.device_label;
        session.status = input.status;
        session.heartbeat_at = ctx.timestamp;
        session.expires_at = expires_at;
        ctx.db.presence_session().key().update(session);
    } else {
        let active_count = ctx
            .db
            .presence_session()
            .scope_key()
            .filter(&scope_key)
            .count();
        if !crate::policy::presence_session_admission_allowed(
            false,
            active_count,
            MAX_PRESENCE_SESSIONS_PER_SCOPE,
        ) {
            return Err("presence session cap reached for identity and workspace".into());
        }
        ctx.db.presence_session().insert(PresenceSession {
            key: key.clone(),
            scope_key: scope_key.clone(),
            workspace_id: input.workspace_id,
            identity: ctx.sender(),
            session_id: input.session_id,
            device_kind: input.device_kind,
            device_label: input.device_label,
            status: input.status,
            created_at: ctx.timestamp,
            heartbeat_at: ctx.timestamp,
            expires_at,
        });
    }
    let schedule = PresenceExpirySchedule {
        scheduled_id: ctx
            .db
            .presence_expiry_schedule()
            .presence_key()
            .find(key.clone())
            .map_or(0, |row| row.scheduled_id),
        scheduled_at: expires_at.into(),
        presence_key: key.clone(),
        expected_expires_at: expires_at,
    };
    if schedule.scheduled_id == 0 {
        ctx.db.presence_expiry_schedule().insert(schedule);
    } else {
        ctx.db
            .presence_expiry_schedule()
            .scheduled_id()
            .update(schedule);
    }
    refresh_current_presence(ctx, input.workspace_id, ctx.sender());
    Ok(())
}

#[spacetimedb::reducer]
pub fn expire_presence_schedule(
    ctx: &ReducerContext,
    schedule: PresenceExpirySchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("presence expiry may only be invoked by the scheduler".into());
    }
    if let Some(session) = ctx
        .db
        .presence_session()
        .key()
        .find(schedule.presence_key.clone())
        && session.expires_at == schedule.expected_expires_at
        && session.expires_at <= ctx.timestamp
    {
        let workspace_id = session.workspace_id;
        let identity = session.identity;
        ctx.db.presence_session().key().delete(session.key);
        refresh_current_presence(ctx, workspace_id, identity);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn expire_presence_sessions(
    ctx: &ReducerContext,
    workspace_id: Uuid,
    max_rows: u32,
) -> Result<(), String> {
    require_workspace_action(ctx, workspace_id, Action::Read)?;
    if !(1..=256).contains(&max_rows) {
        return Err("presence cleanup limit must be between 1 and 256".into());
    }
    let expired: Vec<_> = ctx
        .db
        .presence_session()
        .workspace_id()
        .filter(workspace_id)
        .filter(|session| session.expires_at <= ctx.timestamp)
        .take(max_rows as usize)
        .map(|session| (session.key, session.identity))
        .collect();
    for (key, identity) in expired {
        remove_presence_session(ctx, &key);
        refresh_current_presence(ctx, workspace_id, identity);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn set_notification_preference(
    ctx: &ReducerContext,
    input: SetNotificationPreferenceInput,
) -> Result<(), String> {
    require_workspace_action(ctx, input.workspace_id, Action::Read)?;
    if !crate::policy::notification_preference_valid(
        input.mute_start_local_minute,
        input.mute_end_local_minute,
        input.digest_local_minute,
        &input.time_zone,
    ) {
        return Err("notification preference is invalid".into());
    }
    if let Some(space_id) = input.space_id {
        let space = ctx
            .db
            .space()
            .id()
            .find(space_id)
            .filter(|space| space.workspace_id == input.workspace_id)
            .ok_or_else(|| "notification preference space unavailable".to_string())?;
        if !can_read_space(ctx, &space, ctx.sender()) {
            return Err("notification preference space unavailable".into());
        }
    }
    let input_hash = normalized_input_hash(&format!(
        "{}\0{:?}\0{:?}\0{:?}\0{:?}\0{:?}\0{:?}\0{}\0{}\0{}",
        input.workspace_id,
        input.space_id,
        input.direct_mode,
        input.important_mode,
        input.ambient_mode,
        input.mute_start_local_minute,
        input.mute_end_local_minute,
        input.time_zone,
        input.digest_local_minute,
        input.expected_revision,
    ));
    if existing_receipt(
        ctx,
        Some(input.workspace_id),
        "set_notification_preference",
        input.client_request_id,
        &input_hash,
    )?
    .is_some()
    {
        return Ok(());
    }
    let key = notification_preference_key(input.workspace_id, input.space_id, ctx.sender());
    if let Some(mut preference) = ctx.db.notification_preference().key().find(key.clone()) {
        revision_matches(preference.revision, input.expected_revision)?;
        preference.direct_mode = input.direct_mode;
        preference.important_mode = input.important_mode;
        preference.ambient_mode = input.ambient_mode;
        preference.mute_start_local_minute = input.mute_start_local_minute;
        preference.mute_end_local_minute = input.mute_end_local_minute;
        preference.time_zone = input.time_zone;
        preference.digest_local_minute = input.digest_local_minute;
        preference.revision = preference
            .revision
            .checked_add(1)
            .ok_or_else(|| "notification preference revision exhausted".to_string())?;
        preference.updated_at = ctx.timestamp;
        ctx.db.notification_preference().key().update(preference);
    } else {
        if input.expected_revision != 0 {
            return Err("new notification preference must use expected revision 0".into());
        }
        ctx.db
            .notification_preference()
            .insert(NotificationPreference {
                key: key.clone(),
                identity: ctx.sender(),
                workspace_id: input.workspace_id,
                space_id: input.space_id,
                direct_mode: input.direct_mode,
                important_mode: input.important_mode,
                ambient_mode: input.ambient_mode,
                mute_start_local_minute: input.mute_start_local_minute,
                mute_end_local_minute: input.mute_end_local_minute,
                time_zone: input.time_zone,
                digest_local_minute: input.digest_local_minute,
                revision: 1,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });
    }
    let committed_preference = ctx
        .db
        .notification_preference()
        .key()
        .find(key)
        .ok_or_else(|| "notification preference commit unavailable".to_string())?;
    refresh_notification_digest_schedule_preference(ctx, &committed_preference)?;
    insert_receipt(
        ctx,
        Some(input.workspace_id),
        "set_notification_preference",
        input.client_request_id,
        input_hash,
        "notification_preference",
        input.space_id.unwrap_or(input.workspace_id),
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn authorize_notification_delivery(
    ctx: &ReducerContext,
    job_id: Uuid,
    worker_slot_id: String,
    lease_generation: u64,
    permit_seconds: u32,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&worker_slot_id)
        || !(1..=NOTIFICATION_PERMIT_MAX_SECONDS).contains(&permit_seconds)
    {
        return Err("notification delivery permit request is invalid".into());
    }
    let job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .filter(|job| job.kind == JOB_NOTIFICATION_DELIVER)
        .ok_or_else(|| "notification delivery plan unavailable".to_string())?;
    require_service(ctx, job.workspace_id, JOB_NOTIFICATION_DELIVER)?;
    if job.state != OutboxState::Leased
        || job.lease_owner != Some(ctx.sender())
        || job.worker_slot_id != worker_slot_id
        || job.lease_generation != lease_generation
        || job
            .lease_until
            .is_none_or(|expires_at| expires_at <= ctx.timestamp)
    {
        return Err("notification delivery plan unavailable".into());
    }
    let notification = ctx
        .db
        .notification()
        .id()
        .find(job.resource_id)
        .ok_or_else(|| "notification delivery plan unavailable".to_string())?;
    let mut control = ctx
        .db
        .notification_control()
        .notification_id()
        .find(notification.id)
        .ok_or_else(|| "notification delivery plan unavailable".to_string())?;
    let snapshot = notification_authority_snapshot(ctx, &notification, &control);
    let exact_job_binding = crate::policy::notification_delivery_binding_valid(&[
        job.resource_type == "notification",
        job.intent_id == Some(notification.id),
        job.recipient_id == Some(control.recipient_identity),
        job.payload_resource_id == Some(control.resource_id),
        job.authorization_epoch == Some(control.membership_epoch),
        job.resource_revision == control.group_revision,
        job.version == Some(control.group_revision),
        job.channel == control.channel,
        job.minimal_message == notification.summary,
        snapshot.membership_epoch == control.membership_epoch,
        snapshot.preference_revision == control.preference_revision,
        snapshot.resource_revision == control.resource_revision,
    ]);
    if !exact_job_binding || snapshot.delivery_state != NotificationDeliveryState::Pending {
        ctx.db
            .notification_delivery_permit()
            .job_id()
            .delete(job_id);
        return Err("notification delivery plan unavailable".into());
    }
    let lease_until = job
        .lease_until
        .ok_or_else(|| "notification delivery plan unavailable".to_string())?;
    let requested_expiry =
        ctx.timestamp + TimeDuration::from_micros(i64::from(permit_seconds) * 1_000_000);
    let permit = NotificationDeliveryPermit {
        job_id,
        notification_id: notification.id,
        workspace_id: job.workspace_id,
        service_identity: ctx.sender(),
        worker_slot_id,
        lease_generation,
        group_key: control.group_key.clone(),
        group_revision: control.group_revision,
        resource_revision: control.resource_revision,
        membership_epoch: control.membership_epoch,
        preference_revision: control.preference_revision,
        channel: control.channel.clone(),
        expires_at: std::cmp::min(lease_until, requested_expiry),
        created_at: ctx.timestamp,
    };
    if ctx
        .db
        .notification_delivery_permit()
        .job_id()
        .find(job_id)
        .is_some()
    {
        ctx.db
            .notification_delivery_permit()
            .job_id()
            .update(permit);
    } else {
        ctx.db.notification_delivery_permit().insert(permit);
    }
    control.delivery_state = NotificationDeliveryState::Pending;
    control.suppression_reason.clear();
    control.updated_at = ctx.timestamp;
    ctx.db
        .notification_control()
        .notification_id()
        .update(control);
    Ok(())
}

pub(crate) struct NotificationDigestAuthoritySnapshot {
    pub(crate) suppression_code: String,
    pub(crate) body: String,
    pub(crate) item_count: u16,
}

fn notification_digest_occurrence_key(schedule_id: Uuid, local_date: &str) -> String {
    format!("{schedule_id}:{local_date}")
}

pub(crate) fn notification_digest_authority_snapshot<C: DbContext>(
    ctx: &C,
    schedule: &NotificationDigestSchedule,
    claim: &NotificationDigestClaim,
) -> NotificationDigestAuthoritySnapshot {
    let suppressed = |code: &str| NotificationDigestAuthoritySnapshot {
        suppression_code: code.into(),
        body: String::new(),
        item_count: 0,
    };
    if !workspace_is_active(ctx, schedule.workspace_id) {
        return suppressed("workspace_fenced");
    }
    let Some(membership) = find_membership(ctx, schedule.workspace_id, schedule.recipient_identity)
        .filter(|membership| membership.active)
    else {
        return suppressed("permission_revoked");
    };
    if claim.schedule_id != schedule.id
        || claim.workspace_id != schedule.workspace_id
        || claim.recipient_identity != schedule.recipient_identity
        || claim.channel != schedule.channel
        || claim.authorization_epoch != membership.authz_epoch
    {
        return suppressed("permission_revoked");
    }
    if schedule.digest_revision < claim.digest_revision {
        return suppressed("digest_revision_stale");
    }
    let mut summaries = Vec::new();
    let mut omitted = 0_u64;
    let mut eligible_count = 0_u16;
    for item in ctx
        .db_read_only()
        .notification_digest_item()
        .schedule_id()
        .filter(schedule.id)
        .filter(|item| item.digest_revision <= claim.digest_revision)
        .take(NOTIFICATION_DIGEST_MAX_ITEMS + 1)
    {
        if eligible_count as usize >= NOTIFICATION_DIGEST_MAX_ITEMS {
            return suppressed("digest_revision_stale");
        }
        let Some(notification) = ctx
            .db_read_only()
            .notification()
            .id()
            .find(item.notification_id)
        else {
            continue;
        };
        let Some(control) = ctx
            .db_read_only()
            .notification_control()
            .notification_id()
            .find(item.notification_id)
        else {
            continue;
        };
        let preference = notification_mode(
            ctx,
            schedule.workspace_id,
            control.space_id,
            schedule.recipient_identity,
            control.tier,
        );
        if preference.key != schedule.preference_key
            || preference.revision != claim.preference_revision
        {
            return suppressed("preference_revision_stale");
        }
        if preference.mute_window_configured {
            return suppressed("policy_suppressed");
        }
        match preference.mode {
            NotificationDeliveryMode::Disabled => return suppressed("recipient_opted_out"),
            NotificationDeliveryMode::Immediate => {
                return suppressed("preference_revision_stale");
            }
            NotificationDeliveryMode::Digest => {}
        }
        let resource_revision = notification_resource_revision(
            ctx,
            schedule.workspace_id,
            &control.resource_type,
            control.resource_id,
        );
        let authority_binding_current = notification.workspace_id == schedule.workspace_id
            && notification.recipient_identity == schedule.recipient_identity
            && notification.id == control.notification_id
            && control.channel == schedule.channel
            && control.membership_epoch == claim.authorization_epoch
            && resource_revision == Some(control.resource_revision)
            && notification_resource_visible_to(
                ctx,
                schedule.workspace_id,
                schedule.recipient_identity,
                &control.resource_type,
                control.resource_id,
            );
        if !crate::policy::notification_digest_item_eligible(
            notification.read_at.is_some(),
            authority_binding_current,
        ) {
            continue;
        }
        eligible_count = eligible_count.saturating_add(1);
        let line = format!("- {}", notification.summary.trim());
        let projected_bytes =
            summaries.iter().map(String::len).sum::<usize>() + line.len() + summaries.len();
        let projected_characters = summaries
            .iter()
            .map(|value| value.chars().count())
            .sum::<usize>()
            + line.chars().count()
            + summaries.len();
        if projected_bytes <= 3_500 && projected_characters <= 1_750 {
            summaries.push(line);
        } else {
            omitted = omitted.saturating_add(1);
        }
    }
    if claim.overflow_count > 0 {
        omitted = omitted.saturating_add(claim.overflow_count);
    }
    if eligible_count == 0 && omitted == 0 {
        return suppressed("no_content");
    }
    if omitted > 0 {
        summaries.push(format!("- and {omitted} more updates"));
    }
    NotificationDigestAuthoritySnapshot {
        suppression_code: String::new(),
        body: summaries.join("\n"),
        item_count: eligible_count.max(1),
    }
}

#[spacetimedb::reducer]
pub fn claim_notification_digests(
    ctx: &ReducerContext,
    input: ClaimNotificationDigestsInput,
) -> Result<(), String> {
    if input.occurrences.is_empty()
        || input.occurrences.len() > NOTIFICATION_DIGEST_MAX_CLAIMS
        || !crate::policy::worker_slot_id_valid(&input.worker_slot_id)
        || !(5..=NOTIFICATION_DIGEST_MAX_LEASE_SECONDS).contains(&input.lease_seconds)
    {
        return Err("notification digest claim input is invalid".into());
    }
    let lease_until =
        ctx.timestamp + TimeDuration::from_micros(i64::from(input.lease_seconds) * 1_000_000);
    for occurrence in input.occurrences {
        if !crate::policy::notification_digest_local_date_valid(&occurrence.local_date)
            || occurrence.scheduled_for > ctx.timestamp
            || occurrence.expected_digest_revision == 0
        {
            return Err("notification digest occurrence is invalid".into());
        }
        let mut schedule = ctx
            .db
            .notification_digest_schedule()
            .id()
            .find(occurrence.schedule_id)
            .ok_or_else(|| "notification digest schedule unavailable".to_string())?;
        require_service(ctx, schedule.workspace_id, JOB_NOTIFICATION_DELIVER)?;
        if let Some(mut claim) = ctx
            .db
            .notification_digest_claim()
            .schedule_id()
            .find(schedule.id)
        {
            if claim.local_date != occurrence.local_date
                || claim.scheduled_for != occurrence.scheduled_for
                || !crate::policy::notification_digest_claim_recovery_allowed(
                    claim.preference_revision,
                    claim.digest_revision,
                    occurrence.expected_preference_revision,
                    occurrence.expected_digest_revision,
                    schedule.digest_revision,
                    claim.next_attempt_at <= ctx.timestamp,
                    claim.lease_until <= ctx.timestamp,
                )
            {
                return Err("notification digest claim unavailable".into());
            }
            if claim.state == NotificationDigestClaimState::Claimed {
                claim.state = NotificationDigestClaimState::OutcomeUnknown;
            }
            claim.service_identity = ctx.sender();
            claim.worker_slot_id = input.worker_slot_id.clone();
            claim.lease_generation = claim
                .lease_generation
                .checked_add(1)
                .ok_or_else(|| "notification digest lease generation exhausted".to_string())?;
            claim.lease_until = lease_until;
            claim.attempt_count = claim.attempt_count.saturating_add(1);
            claim.updated_at = ctx.timestamp;
            ctx.db.notification_digest_claim().claim_id().update(claim);
            continue;
        }
        if schedule.preference_revision != occurrence.expected_preference_revision
            || schedule.digest_revision != occurrence.expected_digest_revision
        {
            return Err("notification digest schedule is stale".into());
        }
        let membership = find_membership(ctx, schedule.workspace_id, schedule.recipient_identity)
            .filter(|membership| membership.active)
            .ok_or_else(|| "notification digest recipient unavailable".to_string())?;
        if (!schedule.last_occurrence_local_date.is_empty()
            && occurrence.local_date <= schedule.last_occurrence_local_date)
            || ctx
                .db
                .notification_digest_outcome()
                .occurrence_key()
                .find(notification_digest_occurrence_key(
                    schedule.id,
                    &occurrence.local_date,
                ))
                .is_some()
        {
            return Err("notification digest occurrence already claimed".into());
        }
        let item_count = ctx
            .db
            .notification_digest_item()
            .schedule_id()
            .filter(schedule.id)
            .take(NOTIFICATION_DIGEST_MAX_ITEMS)
            .count();
        if item_count == 0 && schedule.overflow_count == 0 {
            return Err("notification digest has no pending content".into());
        }
        let claim = NotificationDigestClaim {
            claim_id: new_id(ctx)?,
            schedule_id: schedule.id,
            workspace_id: schedule.workspace_id,
            recipient_identity: schedule.recipient_identity,
            channel: schedule.channel.clone(),
            local_date: occurrence.local_date.clone(),
            scheduled_for: occurrence.scheduled_for,
            preference_revision: schedule.preference_revision,
            digest_revision: schedule.digest_revision,
            authorization_epoch: membership.authz_epoch,
            overflow_count: if schedule.overflow_revision <= schedule.digest_revision {
                schedule.overflow_count
            } else {
                0
            },
            state: NotificationDigestClaimState::Claimed,
            service_identity: ctx.sender(),
            worker_slot_id: input.worker_slot_id.clone(),
            lease_generation: 1,
            lease_until,
            attempt_count: 1,
            next_attempt_at: ctx.timestamp,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        };
        schedule.last_occurrence_local_date = occurrence.local_date;
        schedule.updated_at = ctx.timestamp;
        ctx.db.notification_digest_schedule().id().update(schedule);
        ctx.db.notification_digest_claim().insert(claim);
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn authorize_notification_digest(
    ctx: &ReducerContext,
    input: AuthorizeNotificationDigestInput,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&input.worker_slot_id)
        || !(1..=NOTIFICATION_PERMIT_MAX_SECONDS).contains(&input.permit_seconds)
    {
        return Err("notification digest permit request is invalid".into());
    }
    let claim = ctx
        .db
        .notification_digest_claim()
        .claim_id()
        .find(input.claim_id)
        .ok_or_else(|| "notification digest plan unavailable".to_string())?;
    require_service(ctx, claim.workspace_id, JOB_NOTIFICATION_DELIVER)?;
    if claim.service_identity != ctx.sender()
        || claim.worker_slot_id != input.worker_slot_id
        || claim.lease_generation != input.lease_generation
        || claim.lease_until <= ctx.timestamp
    {
        return Err("notification digest plan unavailable".into());
    }
    let schedule = ctx
        .db
        .notification_digest_schedule()
        .id()
        .find(claim.schedule_id)
        .ok_or_else(|| "notification digest plan unavailable".to_string())?;
    let snapshot = notification_digest_authority_snapshot(ctx, &schedule, &claim);
    if !snapshot.suppression_code.is_empty() {
        ctx.db
            .notification_digest_permit()
            .claim_id()
            .delete(claim.claim_id);
        return Err("notification digest plan unavailable".into());
    }
    let expires_at = std::cmp::min(
        claim.lease_until,
        ctx.timestamp + TimeDuration::from_micros(i64::from(input.permit_seconds) * 1_000_000),
    );
    let permit = NotificationDigestPermit {
        claim_id: claim.claim_id,
        workspace_id: claim.workspace_id,
        schedule_id: claim.schedule_id,
        service_identity: ctx.sender(),
        worker_slot_id: input.worker_slot_id,
        lease_generation: claim.lease_generation,
        preference_revision: claim.preference_revision,
        digest_revision: claim.digest_revision,
        authorization_epoch: claim.authorization_epoch,
        expires_at,
        created_at: ctx.timestamp,
    };
    if ctx
        .db
        .notification_digest_permit()
        .claim_id()
        .find(claim.claim_id)
        .is_some()
    {
        ctx.db
            .notification_digest_permit()
            .claim_id()
            .update(permit);
    } else {
        ctx.db.notification_digest_permit().insert(permit);
    }
    Ok(())
}

fn notification_digest_permit_current(
    ctx: &ReducerContext,
    claim: &NotificationDigestClaim,
) -> bool {
    ctx.db
        .notification_digest_permit()
        .claim_id()
        .find(claim.claim_id)
        .is_some_and(|permit| {
            permit.workspace_id == claim.workspace_id
                && permit.schedule_id == claim.schedule_id
                && permit.service_identity == ctx.sender()
                && permit.worker_slot_id == claim.worker_slot_id
                && permit.lease_generation == claim.lease_generation
                && permit.preference_revision == claim.preference_revision
                && permit.digest_revision == claim.digest_revision
                && permit.authorization_epoch == claim.authorization_epoch
                && permit.expires_at > ctx.timestamp
        })
}

#[spacetimedb::reducer]
pub fn record_notification_digest_outcome(
    ctx: &ReducerContext,
    input: RecordNotificationDigestOutcomeInput,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&input.worker_slot_id)
        || input.provider_reference.len() > 256
        || (!input.provider_reference.is_empty()
            && !crate::policy::notification_provider_reference_valid(&input.provider_reference))
        || input.code.len() > 128
        || input.retry_after_seconds > 86_400
    {
        return Err("notification digest outcome input is invalid".into());
    }
    let mut claim = ctx
        .db
        .notification_digest_claim()
        .claim_id()
        .find(input.claim_id)
        .ok_or_else(|| "notification digest claim unavailable".to_string())?;
    require_service(ctx, claim.workspace_id, JOB_NOTIFICATION_DELIVER)?;
    if claim.service_identity != ctx.sender()
        || claim.worker_slot_id != input.worker_slot_id
        || claim.lease_generation != input.lease_generation
        || claim.lease_until <= ctx.timestamp
    {
        return Err("notification digest claim unavailable".into());
    }
    let schedule = ctx
        .db
        .notification_digest_schedule()
        .id()
        .find(claim.schedule_id)
        .ok_or_else(|| "notification digest claim unavailable".to_string())?;
    let snapshot = notification_digest_authority_snapshot(ctx, &schedule, &claim);
    let permit_current = notification_digest_permit_current(ctx, &claim);
    let transient_code = matches!(
        input.code.as_str(),
        "rate_limited" | "provider_unavailable" | "network_error"
    );
    let permanent_code = matches!(
        input.code.as_str(),
        "invalid_recipient" | "recipient_unreachable" | "provider_rejected" | "channel_unavailable"
    );
    let unknown_code = matches!(
        input.code.as_str(),
        "provider_timeout" | "connection_lost_after_send"
    );
    let exact_shape = match input.outcome {
        NotificationDigestCompletionOutcome::Succeeded => {
            !input.provider_reference.is_empty()
                && input.code.is_empty()
                && input.retry_after_seconds == 0
                && ((input.reconciled
                    && claim.state == NotificationDigestClaimState::OutcomeUnknown)
                    || (!input.reconciled && permit_current))
        }
        NotificationDigestCompletionOutcome::Suppressed => {
            input.provider_reference.is_empty()
                && !snapshot.suppression_code.is_empty()
                && input.code == snapshot.suppression_code
                && input.retry_after_seconds == 0
                && !input.reconciled
        }
        NotificationDigestCompletionOutcome::TransientFailure => {
            input.provider_reference.is_empty()
                && transient_code
                && permit_current
                && !input.reconciled
        }
        NotificationDigestCompletionOutcome::PermanentFailure => {
            input.provider_reference.is_empty()
                && permanent_code
                && input.retry_after_seconds == 0
                && permit_current
                && !input.reconciled
        }
        NotificationDigestCompletionOutcome::OutcomeUnknown => {
            input.provider_reference.is_empty()
                && unknown_code
                && permit_current
                && !input.reconciled
        }
        NotificationDigestCompletionOutcome::ReconciliationUnknown => {
            input.provider_reference.is_empty()
                && input.code == "unknown"
                && claim.state == NotificationDigestClaimState::OutcomeUnknown
                && input.reconciled
        }
    };
    if !exact_shape {
        return Err("notification digest outcome authority is stale".into());
    }
    let terminal = match input.outcome {
        NotificationDigestCompletionOutcome::Succeeded => {
            Some(NotificationDigestTerminalOutcome::Succeeded)
        }
        NotificationDigestCompletionOutcome::Suppressed => {
            Some(NotificationDigestTerminalOutcome::Suppressed)
        }
        NotificationDigestCompletionOutcome::PermanentFailure => {
            Some(NotificationDigestTerminalOutcome::PermanentFailure)
        }
        _ => None,
    };
    if let Some(outcome) = terminal {
        let clear_batch = input.outcome != NotificationDigestCompletionOutcome::Suppressed
            || matches!(
                input.code.as_str(),
                "no_content"
                    | "recipient_opted_out"
                    | "channel_disabled"
                    | "recipient_suspended"
                    | "permission_revoked"
            );
        let occurrence_key =
            notification_digest_occurrence_key(claim.schedule_id, &claim.local_date);
        if ctx
            .db
            .notification_digest_outcome()
            .occurrence_key()
            .find(occurrence_key.clone())
            .is_some()
        {
            return Err("notification digest outcome already recorded".into());
        }
        ctx.db
            .notification_digest_outcome()
            .insert(NotificationDigestOutcome {
                occurrence_key,
                schedule_id: claim.schedule_id,
                workspace_id: claim.workspace_id,
                local_date: claim.local_date.clone(),
                digest_revision: claim.digest_revision,
                outcome,
                provider_reference: input.provider_reference,
                code: input.code,
                completed_at: ctx.timestamp,
            });
        if clear_batch {
            let item_ids: Vec<_> = ctx
                .db
                .notification_digest_item()
                .schedule_id()
                .filter(claim.schedule_id)
                .filter(|item| item.digest_revision <= claim.digest_revision)
                .take(NOTIFICATION_DIGEST_MAX_ITEMS)
                .map(|item| item.notification_id)
                .collect();
            for notification_id in item_ids {
                ctx.db
                    .notification_digest_item()
                    .notification_id()
                    .delete(notification_id);
            }
        }
        if clear_batch && schedule.overflow_revision <= claim.digest_revision {
            let mut updated = schedule;
            updated.overflow_count = 0;
            updated.overflow_revision = 0;
            updated.updated_at = ctx.timestamp;
            ctx.db.notification_digest_schedule().id().update(updated);
        }
        ctx.db
            .notification_digest_permit()
            .claim_id()
            .delete(claim.claim_id);
        ctx.db
            .notification_digest_claim()
            .claim_id()
            .delete(claim.claim_id);
        return Ok(());
    }
    claim.state = match input.outcome {
        NotificationDigestCompletionOutcome::TransientFailure => {
            NotificationDigestClaimState::Retry
        }
        NotificationDigestCompletionOutcome::OutcomeUnknown
        | NotificationDigestCompletionOutcome::ReconciliationUnknown => {
            NotificationDigestClaimState::OutcomeUnknown
        }
        _ => unreachable!("terminal digest outcomes returned above"),
    };
    claim.next_attempt_at = ctx.timestamp
        + TimeDuration::from_micros(i64::from(input.retry_after_seconds.max(1)) * 1_000_000);
    claim.lease_until = ctx.timestamp;
    claim.updated_at = ctx.timestamp;
    ctx.db
        .notification_digest_claim()
        .claim_id()
        .update(claim.clone());
    ctx.db
        .notification_digest_permit()
        .claim_id()
        .delete(claim.claim_id);
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
        || !notification_resource_visible_to(
            ctx,
            row.workspace_id,
            ctx.sender(),
            &row.resource_type,
            row.resource_id,
        )
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
    let kind = kind.trim().to_string();
    if crate::policy::CanonicalJobKind::parse(&kind).is_none() {
        return Err("service grant kind is not a canonical worker job kind".into());
    }
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
    enqueue_outbox(
        ctx,
        OutboxInsert {
            workspace_id: thread.workspace_id,
            kind: JOB_AGENT_RUN,
            resource_type: "agent_run",
            resource_id: id,
            resource_revision: 1,
            effect_key: format!("agent-run:{id}"),
            payload: OutboxSemanticPayload {
                run_id: Some(id),
                ..Default::default()
            },
        },
    )?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
    require_service(ctx, run.workspace_id, "agent.run")?;
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
        let thread = ctx
            .db
            .named_thread()
            .id()
            .find(thread_id)
            .ok_or_else(|| "agent output thread not found".to_string())?;
        let mut post = ctx
            .db
            .post()
            .id()
            .find(thread.root_post_id)
            .ok_or_else(|| "agent output root post not found".to_string())?;
        if thread.archived || post.deleted || post.locked || post.state == PostState::Archived {
            return Err("agent output destination is closed".into());
        }
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
        append_post_activity(ctx, &mut post, "agent_output_added", "Agent output added")?;
        ctx.db.post().id().update(post);
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
    worker_slot_id: String,
    lease_seconds: u32,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&worker_slot_id) {
        return Err("worker slot id is invalid".into());
    }
    if !(1..=300).contains(&lease_seconds) {
        return Err("outbox lease must be between 1 and 300 seconds".into());
    }
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "outbox job not found".to_string())?;
    let expired_lease = job.state == OutboxState::Leased
        && job
            .lease_until
            .is_some_and(|expiry| expiry <= ctx.timestamp);
    let fenced_generation_reconciliation = job.kind == JOB_WORKSPACE_EXPORT_GENERATE
        && !workspace_is_active(ctx, job.workspace_id)
        && crate::policy::workspace_export_reconciliation_after_fence_allowed(
            job.state == OutboxState::OutcomeUnknown,
            expired_lease,
            job.attempt > 0,
            true,
        );
    if fenced_generation_reconciliation {
        require_export_generation_completion_service(ctx, job.workspace_id)?;
    } else {
        require_service(ctx, job.workspace_id, &job.kind)?;
    }
    if job.attempt >= OUTBOX_MAX_ATTEMPTS || job.expires_at <= ctx.timestamp {
        job.state = OutboxState::DeadLetter;
        job.last_error = "outbox_limits_exhausted".into();
        job.lease_owner = None;
        job.worker_slot_id.clear();
        job.lease_until = None;
        job.updated_at = ctx.timestamp;
        ctx.db.outbox_job().id().update(job);
        return Ok(());
    }
    let proposed_lease_until =
        ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000);
    if job.lease_generation != expected_generation
        || !(matches!(
            job.state,
            OutboxState::Pending | OutboxState::Retry | OutboxState::OutcomeUnknown
        ) || expired_lease)
        || (!expired_lease && job.next_attempt_at > ctx.timestamp)
        || (job.kind == JOB_WORKSPACE_EXPORT_GENERATE
            && !crate::policy::workspace_export_generation_lease_within_ttl(
                proposed_lease_until,
                job.expires_at,
            ))
    {
        return Err("outbox job is not claimable".into());
    }
    job.state = OutboxState::Leased;
    job.attempt = job.attempt.saturating_add(1);
    job.lease_owner = Some(ctx.sender());
    job.worker_slot_id = worker_slot_id;
    job.lease_until = Some(proposed_lease_until);
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
    worker_slot_id: String,
    lease_seconds: u32,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&worker_slot_id) {
        return Err("worker slot id is invalid".into());
    }
    if !(1..=300).contains(&lease_seconds) {
        return Err("outbox lease must be between 1 and 300 seconds".into());
    }
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "outbox job not found".to_string())?;
    let exact_lease = job.state == OutboxState::Leased
        && job.lease_owner == Some(ctx.sender())
        && job.worker_slot_id == worker_slot_id
        && job.lease_generation == lease_generation
        && job.lease_until.is_some_and(|expiry| expiry > ctx.timestamp);
    if !exact_lease {
        return Err("stale or expired outbox lease".into());
    }
    let proposed_lease_until =
        ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000);
    if job.kind == JOB_WORKSPACE_EXPORT_GENERATE
        && !crate::policy::workspace_export_generation_lease_within_ttl(
            proposed_lease_until,
            job.expires_at,
        )
    {
        return Err("workspace export generation lease exceeds artifact TTL safety".into());
    }
    if job.kind == JOB_WORKSPACE_EXPORT_GENERATE && !workspace_is_active(ctx, job.workspace_id) {
        require_export_generation_completion_service(ctx, job.workspace_id)?;
        if !crate::policy::workspace_export_generation_after_fence_allowed(true, true, true, true) {
            return Err("service capability denied".into());
        }
    } else {
        require_service(ctx, job.workspace_id, &job.kind)?;
    }
    job.lease_until = Some(proposed_lease_until);
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}

#[spacetimedb::reducer]
pub fn recover_outbox_job(
    ctx: &ReducerContext,
    job_id: Uuid,
    expected_generation: u64,
    worker_slot_id: String,
    lease_seconds: u32,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&worker_slot_id) {
        return Err("worker slot id is invalid".into());
    }
    if !(1..=300).contains(&lease_seconds) {
        return Err("outbox recovery lease must be between 1 and 300 seconds".into());
    }
    let mut job = ctx
        .db
        .outbox_job()
        .id()
        .find(job_id)
        .ok_or_else(|| "outbox job not found".to_string())?;
    let recovery_allowed = crate::policy::outbox_recovery_allowed(
        job.state == OutboxState::Leased,
        job.lease_owner == Some(ctx.sender()),
        job.worker_slot_id == worker_slot_id,
        job.lease_generation == expected_generation,
        job.lease_until.is_some_and(|expiry| expiry > ctx.timestamp),
    );
    if !recovery_allowed {
        return Err("owned outbox lease is unavailable for recovery".into());
    }
    let proposed_lease_until =
        ctx.timestamp + TimeDuration::from_micros(i64::from(lease_seconds) * 1_000_000);
    if job.kind == JOB_WORKSPACE_EXPORT_GENERATE
        && !crate::policy::workspace_export_generation_lease_within_ttl(
            proposed_lease_until,
            job.expires_at,
        )
    {
        return Err("workspace export generation lease exceeds artifact TTL safety".into());
    }
    if job.kind == JOB_WORKSPACE_EXPORT_GENERATE && !workspace_is_active(ctx, job.workspace_id) {
        require_export_generation_completion_service(ctx, job.workspace_id)?;
        if !crate::policy::workspace_export_generation_after_fence_allowed(true, true, true, true) {
            return Err("service capability denied".into());
        }
    } else {
        require_service(ctx, job.workspace_id, &job.kind)?;
    }
    job.lease_generation = crate::policy::recovered_outbox_generation(job.lease_generation)
        .ok_or_else(|| "outbox lease generation exhausted".to_string())?;
    job.lease_until = Some(proposed_lease_until);
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}

#[spacetimedb::reducer]
pub fn complete_outbox_job(
    ctx: &ReducerContext,
    job_id: Uuid,
    lease_generation: u64,
    worker_slot_id: String,
    outcome: OutboxState,
    last_error: String,
    retry_after_seconds: u32,
) -> Result<(), String> {
    if !crate::policy::worker_slot_id_valid(&worker_slot_id) {
        return Err("worker slot id is invalid".into());
    }
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
    if matches!(
        job.kind.as_str(),
        JOB_WORKSPACE_EXPORT_GENERATE | JOB_WORKSPACE_EXPORT_CLEANUP
    ) {
        return Err("workspace exports require dedicated completion authority".into());
    }
    if job.state != OutboxState::Leased
        || job.lease_owner != Some(ctx.sender())
        || job.worker_slot_id != worker_slot_id
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
    job.worker_slot_id.clear();
    job.lease_until = None;
    job.updated_at = ctx.timestamp;
    ctx.db.outbox_job().id().update(job);
    Ok(())
}
