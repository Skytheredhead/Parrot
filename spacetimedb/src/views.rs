use crate::authz::{
    Action, agent_scope_key, can_read_space, can_read_workspace, find_membership, role_allows,
};
use crate::model::*;
use crate::policy;
use spacetimedb::{Identity, SpacetimeType, Timestamp, Uuid, ViewContext};

#[derive(SpacetimeType)]
pub struct VisibleUser {
    pub identity: Identity,
    pub display_name: String,
}

impl From<User> for VisibleUser {
    fn from(row: User) -> Self {
        Self {
            identity: row.identity,
            display_name: row.display_name,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleWorkspaceMember {
    pub workspace_id: Uuid,
    pub identity: Identity,
    pub role: WorkspaceRole,
    pub active: bool,
}

#[derive(SpacetimeType)]
pub struct VisiblePresence {
    pub workspace_id: Uuid,
    pub identity: Identity,
    pub status: PresenceStatus,
    pub expires_at: Timestamp,
}

impl From<WorkspaceMember> for VisibleWorkspaceMember {
    fn from(row: WorkspaceMember) -> Self {
        Self {
            workspace_id: row.workspace_id,
            identity: row.identity,
            role: row.role,
            active: row.active,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleAgentInstallation {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub enabled: bool,
    pub max_run_tokens: u64,
    pub max_run_cost_micros: u64,
    pub installed_by: Identity,
}

impl From<AgentInstallation> for VisibleAgentInstallation {
    fn from(row: AgentInstallation) -> Self {
        Self {
            id: row.id,
            workspace_id: row.workspace_id,
            name: row.name,
            provider: row.provider,
            model: row.model,
            enabled: row.enabled,
            max_run_tokens: row.max_run_tokens,
            max_run_cost_micros: row.max_run_cost_micros,
            installed_by: row.installed_by,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleAgentScope {
    pub installation_id: Uuid,
    pub space_id: Option<Uuid>,
    pub capability: AgentCapability,
    pub enabled: bool,
}

impl From<AgentScope> for VisibleAgentScope {
    fn from(row: AgentScope) -> Self {
        Self {
            installation_id: row.installation_id,
            space_id: row.space_id,
            capability: row.capability,
            enabled: row.enabled,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleAgentToolPolicy {
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
    pub updated_at: Timestamp,
}

impl From<AgentToolPolicy> for VisibleAgentToolPolicy {
    fn from(row: AgentToolPolicy) -> Self {
        Self {
            installation_id: row.installation_id,
            tool_name: row.tool_name,
            tool_version: row.tool_version,
            capability: row.capability,
            effect_class: row.effect_class,
            trusted_tool_revision: row.trusted_tool_revision,
            requires_approval: row.requires_approval,
            approval_ttl_seconds: row.approval_ttl_seconds,
            enabled: row.enabled,
            revision: row.revision,
            configured_by: row.configured_by,
            updated_at: row.updated_at,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleAgentRun {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub installation_id: Uuid,
    pub space_id: Uuid,
    pub thread_id: Option<Uuid>,
    pub initiated_by: Identity,
    pub state: AgentRunState,
    pub version: u64,
    pub cancel_requested: bool,
    pub prompt_summary: String,
    pub output_summary: String,
    pub used_tokens: u64,
    pub used_cost_micros: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl From<AgentRun> for VisibleAgentRun {
    fn from(row: AgentRun) -> Self {
        Self {
            id: row.id,
            workspace_id: row.workspace_id,
            installation_id: row.installation_id,
            space_id: row.space_id,
            thread_id: row.thread_id,
            initiated_by: row.initiated_by,
            state: row.state,
            version: row.version,
            cancel_requested: row.cancel_requested,
            prompt_summary: row.prompt_summary,
            output_summary: row.output_summary,
            used_tokens: row.used_tokens,
            used_cost_micros: row.used_cost_micros,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleAgentToolCall {
    pub id: Uuid,
    pub run_id: Uuid,
    pub tool_name: String,
    pub tool_version: String,
    pub effect_class: ToolEffectClass,
    pub requires_approval: bool,
    pub state: ToolCallState,
    pub result_summary: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl From<AgentToolCall> for VisibleAgentToolCall {
    fn from(row: AgentToolCall) -> Self {
        Self {
            id: row.id,
            run_id: row.run_id,
            tool_name: row.tool_name,
            tool_version: row.tool_version,
            effect_class: row.effect_class,
            requires_approval: row.requires_approval,
            state: row.state,
            result_summary: row.result_summary,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleCommandReceipt {
    pub workspace_id: Option<Uuid>,
    pub operation: String,
    pub client_request_id: Uuid,
    pub result_type: String,
    pub result_id: Uuid,
    pub committed_at: Timestamp,
}

impl From<CommandReceipt> for VisibleCommandReceipt {
    fn from(row: CommandReceipt) -> Self {
        Self {
            workspace_id: row.workspace_id,
            operation: row.operation,
            client_request_id: row.client_request_id,
            result_type: row.result_type,
            result_id: row.result_id,
            committed_at: row.committed_at,
        }
    }
}

#[derive(SpacetimeType)]
pub struct VisibleApproval {
    pub id: Uuid,
    pub run_id: Uuid,
    pub tool_call_id: Uuid,
    pub effect_class: ToolEffectClass,
    pub state: ApprovalState,
    pub decided_by: Option<Identity>,
    pub expires_at: Timestamp,
}

#[derive(SpacetimeType)]
pub struct VisibleFile {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub space_id: Uuid,
    pub owner_identity: Identity,
    pub file_name: String,
    pub declared_size_bytes: u64,
    pub detected_type: String,
    pub state: FileSecurityState,
    pub revision: u64,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(SpacetimeType)]
pub struct VisiblePostUserState {
    pub post_id: Uuid,
    pub following: bool,
    pub bookmarked: bool,
    pub unread: bool,
    pub last_read_sequence: u64,
    pub read_at: Option<Timestamp>,
}

#[derive(SpacetimeType)]
pub struct VisiblePollOption {
    pub id: Uuid,
    pub post_id: Uuid,
    pub label: String,
    pub position: u32,
    pub vote_count: u64,
    pub viewer_selected: bool,
}

impl From<FileRecord> for VisibleFile {
    fn from(row: FileRecord) -> Self {
        Self {
            id: row.id,
            workspace_id: row.workspace_id,
            space_id: row.space_id,
            owner_identity: row.owner_identity,
            file_name: row.file_name,
            declared_size_bytes: row.declared_size_bytes,
            detected_type: row.detected_type,
            state: row.state,
            revision: row.revision,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

impl From<ApprovalRequest> for VisibleApproval {
    fn from(row: ApprovalRequest) -> Self {
        Self {
            id: row.id,
            run_id: row.run_id,
            tool_call_id: row.tool_call_id,
            effect_class: row.effect_class,
            state: row.state,
            decided_by: row.decided_by,
            expires_at: row.expires_at,
        }
    }
}

fn visible_space(ctx: &ViewContext, space_id: Uuid) -> Option<Space> {
    ctx.db
        .space()
        .id()
        .find(space_id)
        .filter(|space| can_read_space(ctx, space, ctx.sender()))
}

fn accessible_spaces(ctx: &ViewContext) -> Vec<Space> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .space()
                .workspace_id()
                .filter(member.workspace_id)
                .filter(|space| can_read_space(ctx, space, ctx.sender()))
        })
        .collect()
}

fn accessible_threads(ctx: &ViewContext) -> Vec<NamedThread> {
    accessible_spaces(ctx)
        .into_iter()
        .flat_map(|space| ctx.db.named_thread().space_id().filter(space.id))
        .collect()
}

fn accessible_posts(ctx: &ViewContext) -> Vec<Post> {
    accessible_spaces(ctx)
        .into_iter()
        .flat_map(|space| ctx.db.post().space_id().filter(space.id))
        .collect()
}

fn direct_conversation_visible(ctx: &ViewContext, conversation: &DirectConversation) -> bool {
    let user_enabled = ctx
        .db
        .user()
        .identity()
        .find(ctx.sender())
        .is_some_and(|user| !user.disabled);
    let human = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_none();
    let workspace_active = can_read_workspace(ctx, conversation.workspace_id, ctx.sender());
    let participant_active = ctx
        .db
        .direct_participant()
        .key()
        .find(format!("{}:{}", conversation.id, ctx.sender()))
        .is_some_and(|participant| participant.left_at.is_none());
    policy::direct_access_allowed(workspace_active, participant_active, user_enabled && human)
}

fn accessible_direct_conversations(ctx: &ViewContext) -> Vec<DirectConversation> {
    ctx.db
        .direct_participant()
        .identity()
        .filter(ctx.sender())
        .filter(|participant| participant.left_at.is_none())
        .filter_map(|participant| {
            ctx.db
                .direct_conversation()
                .id()
                .find(participant.conversation_id)
        })
        .filter(|conversation| direct_conversation_visible(ctx, conversation))
        .collect()
}

fn direct_resource_visible(ctx: &ViewContext, resource_type: &str, resource_id: Uuid) -> bool {
    let conversation = match resource_type {
        "direct_conversation" => ctx.db.direct_conversation().id().find(resource_id),
        "direct_message" => ctx
            .db
            .direct_message()
            .id()
            .find(resource_id)
            .and_then(|message| {
                ctx.db
                    .direct_conversation()
                    .id()
                    .find(message.conversation_id)
            }),
        "dm_promotion" => ctx
            .db
            .dm_promotion_proposal()
            .id()
            .find(resource_id)
            .and_then(|proposal| {
                ctx.db
                    .direct_conversation()
                    .id()
                    .find(proposal.conversation_id)
            }),
        _ => {
            return policy::private_dm_metadata_visible(
                resource_type.starts_with("direct_") || resource_type.starts_with("dm_"),
                false,
            );
        }
    };
    conversation.is_some_and(|row| direct_conversation_visible(ctx, &row))
}

fn accessible_runs(ctx: &ViewContext) -> Vec<AgentRun> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .agent_run()
                .workspace_id()
                .filter(member.workspace_id)
        })
        .filter(|run| visible_space(ctx, run.space_id).is_some())
        .collect()
}

#[spacetimedb::view(accessor = current_user, public)]
pub fn current_user(ctx: &ViewContext) -> Option<VisibleUser> {
    ctx.db
        .user()
        .identity()
        .find(ctx.sender())
        .map(VisibleUser::from)
}

#[spacetimedb::view(accessor = my_workspace_memberships, public)]
pub fn my_workspace_memberships(ctx: &ViewContext) -> Vec<VisibleWorkspaceMember> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|row| row.active)
        .map(VisibleWorkspaceMember::from)
        .collect()
}

#[spacetimedb::view(accessor = my_workspaces, public)]
pub fn my_workspaces(ctx: &ViewContext) -> Vec<Workspace> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|row| row.active)
        .filter_map(|member| ctx.db.workspace().id().find(member.workspace_id))
        .collect()
}

#[spacetimedb::view(accessor = visible_presence, public)]
pub fn visible_presence(ctx: &ViewContext) -> Vec<VisiblePresence> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|membership| membership.active)
        .flat_map(|membership| {
            ctx.db
                .current_presence()
                .workspace_id()
                .filter(membership.workspace_id)
        })
        .filter(|presence| {
            can_read_workspace(ctx, presence.workspace_id, presence.identity)
                && ctx
                    .db
                    .user()
                    .identity()
                    .find(presence.identity)
                    .is_some_and(|user| !user.disabled)
        })
        .map(|presence| VisiblePresence {
            workspace_id: presence.workspace_id,
            identity: presence.identity,
            status: presence.status,
            expires_at: presence.expires_at,
        })
        .collect()
}

#[spacetimedb::view(accessor = my_notification_preferences, public)]
pub fn my_notification_preferences(ctx: &ViewContext) -> Vec<NotificationPreference> {
    ctx.db
        .notification_preference()
        .identity()
        .filter(ctx.sender())
        .filter(|preference| {
            can_read_workspace(ctx, preference.workspace_id, ctx.sender())
                && preference.space_id.is_none_or(|space_id| {
                    ctx.db
                        .space()
                        .id()
                        .find(space_id)
                        .is_some_and(|space| can_read_space(ctx, &space, ctx.sender()))
                })
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_workspace_members, public)]
pub fn visible_workspace_members(ctx: &ViewContext) -> Vec<VisibleWorkspaceMember> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .workspace_member()
                .workspace_id()
                .filter(member.workspace_id)
                .filter(|row| row.active)
        })
        .map(VisibleWorkspaceMember::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_spaces, public)]
pub fn visible_spaces(ctx: &ViewContext) -> Vec<Space> {
    accessible_spaces(ctx)
}

#[spacetimedb::view(accessor = visible_posts, public)]
pub fn visible_posts(ctx: &ViewContext) -> Vec<Post> {
    accessible_posts(ctx)
}

#[spacetimedb::view(accessor = visible_post_tags, public)]
pub fn visible_post_tags(ctx: &ViewContext) -> Vec<PostTag> {
    accessible_posts(ctx)
        .into_iter()
        .flat_map(|post| ctx.db.post_tag().post_id().filter(post.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_post_mentions, public)]
pub fn visible_post_mentions(ctx: &ViewContext) -> Vec<PostMention> {
    accessible_posts(ctx)
        .into_iter()
        .flat_map(|post| ctx.db.post_mention().post_id().filter(post.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_post_reactions, public)]
pub fn visible_post_reactions(ctx: &ViewContext) -> Vec<PostReaction> {
    accessible_posts(ctx)
        .into_iter()
        .flat_map(|post| ctx.db.post_reaction().post_id().filter(post.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_post_pins, public)]
pub fn visible_post_pins(ctx: &ViewContext) -> Vec<PostPin> {
    accessible_posts(ctx)
        .into_iter()
        .filter_map(|post| ctx.db.post_pin().post_id().find(post.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_post_activity, public)]
pub fn visible_post_activity(ctx: &ViewContext) -> Vec<PostActivity> {
    accessible_posts(ctx)
        .into_iter()
        .flat_map(|post| ctx.db.post_activity().post_id().filter(post.id))
        .collect()
}

#[spacetimedb::view(accessor = my_post_states, public)]
pub fn my_post_states(ctx: &ViewContext) -> Vec<VisiblePostUserState> {
    accessible_posts(ctx)
        .into_iter()
        .map(|post| {
            let state = ctx
                .db
                .post_user_state()
                .key()
                .find(crate::authz::post_identity_key(post.id, ctx.sender()));
            let last_read_sequence = state.as_ref().map_or(0, |row| row.last_read_sequence);
            VisiblePostUserState {
                post_id: post.id,
                following: state.as_ref().is_some_and(|row| row.following),
                bookmarked: state.as_ref().is_some_and(|row| row.bookmarked),
                unread: policy::post_is_unread(
                    post.deleted,
                    post.activity_sequence,
                    last_read_sequence,
                ),
                last_read_sequence,
                read_at: state.and_then(|row| row.read_at),
            }
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_polls, public)]
pub fn visible_polls(ctx: &ViewContext) -> Vec<Poll> {
    accessible_posts(ctx)
        .into_iter()
        .filter_map(|post| ctx.db.poll().post_id().find(post.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_poll_options, public)]
pub fn visible_poll_options(ctx: &ViewContext) -> Vec<VisiblePollOption> {
    accessible_posts(ctx)
        .into_iter()
        .flat_map(|post| ctx.db.poll_option().post_id().filter(post.id))
        .map(|option| VisiblePollOption {
            vote_count: ctx
                .db
                .poll_vote()
                .option_id()
                .filter(option.id)
                .count()
                .try_into()
                .unwrap_or(u64::MAX),
            viewer_selected: ctx
                .db
                .poll_vote()
                .key()
                .find(crate::authz::poll_vote_key(
                    option.post_id,
                    option.id,
                    ctx.sender(),
                ))
                .is_some(),
            id: option.id,
            post_id: option.post_id,
            label: option.label,
            position: option.position,
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_named_threads, public)]
pub fn visible_named_threads(ctx: &ViewContext) -> Vec<NamedThread> {
    accessible_threads(ctx)
}

#[spacetimedb::view(accessor = visible_contributions, public)]
pub fn visible_contributions(ctx: &ViewContext) -> Vec<Contribution> {
    accessible_threads(ctx)
        .into_iter()
        .flat_map(|thread| ctx.db.contribution().thread_id().filter(thread.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_direct_conversations, public)]
pub fn visible_direct_conversations(ctx: &ViewContext) -> Vec<DirectConversation> {
    accessible_direct_conversations(ctx)
}

#[spacetimedb::view(accessor = visible_direct_participants, public)]
pub fn visible_direct_participants(ctx: &ViewContext) -> Vec<DirectParticipant> {
    accessible_direct_conversations(ctx)
        .into_iter()
        .flat_map(|conversation| {
            ctx.db
                .direct_participant()
                .conversation_id()
                .filter(conversation.id)
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_direct_messages, public)]
pub fn visible_direct_messages(ctx: &ViewContext) -> Vec<DirectMessage> {
    accessible_direct_conversations(ctx)
        .into_iter()
        .flat_map(|conversation| {
            ctx.db
                .direct_message()
                .conversation_id()
                .filter(conversation.id)
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_direct_reply_ancestry, public)]
pub fn visible_direct_reply_ancestry(ctx: &ViewContext) -> Vec<DirectReplyAncestry> {
    accessible_direct_conversations(ctx)
        .into_iter()
        .flat_map(|conversation| {
            ctx.db
                .direct_reply_ancestry()
                .conversation_id()
                .filter(conversation.id)
        })
        .collect()
}

#[spacetimedb::view(accessor = my_direct_read_states, public)]
pub fn my_direct_read_states(ctx: &ViewContext) -> Vec<DirectReadState> {
    accessible_direct_conversations(ctx)
        .into_iter()
        .filter_map(|conversation| {
            ctx.db
                .direct_read_state()
                .key()
                .find(format!("{}:{}", conversation.id, ctx.sender()))
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_dm_promotion_proposals, public)]
pub fn visible_dm_promotion_proposals(ctx: &ViewContext) -> Vec<DmPromotionProposal> {
    accessible_direct_conversations(ctx)
        .into_iter()
        .flat_map(|conversation| {
            ctx.db
                .dm_promotion_proposal()
                .conversation_id()
                .filter(conversation.id)
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_dm_promotion_sources, public)]
pub fn visible_dm_promotion_sources(ctx: &ViewContext) -> Vec<DmPromotionSource> {
    visible_dm_promotion_proposals(ctx)
        .into_iter()
        .flat_map(|proposal| {
            ctx.db
                .dm_promotion_source()
                .proposal_id()
                .filter(proposal.id)
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_dm_promotion_consents, public)]
pub fn visible_dm_promotion_consents(ctx: &ViewContext) -> Vec<DmPromotionConsent> {
    visible_dm_promotion_proposals(ctx)
        .into_iter()
        .flat_map(|proposal| {
            ctx.db
                .dm_promotion_consent()
                .proposal_id()
                .filter(proposal.id)
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_reply_ancestry, public)]
pub fn visible_reply_ancestry(ctx: &ViewContext) -> Vec<ReplyAncestry> {
    accessible_threads(ctx)
        .into_iter()
        .flat_map(|thread| ctx.db.contribution().thread_id().filter(thread.id))
        .flat_map(|row| ctx.db.reply_ancestry().descendant_id().filter(row.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_decisions, public)]
pub fn visible_decisions(ctx: &ViewContext) -> Vec<DecisionRecord> {
    accessible_threads(ctx)
        .into_iter()
        .flat_map(|thread| ctx.db.decision_record().thread_id().filter(thread.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_tasks, public)]
pub fn visible_tasks(ctx: &ViewContext) -> Vec<TaskItem> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .task_item()
                .workspace_id()
                .filter(member.workspace_id)
        })
        .filter(|task| {
            let thread_space_visible = task.thread_id.is_some_and(|thread_id| {
                ctx.db
                    .named_thread()
                    .id()
                    .find(thread_id)
                    .is_some_and(|thread| {
                        thread.workspace_id == task.workspace_id
                            && visible_space(ctx, thread.space_id).is_some()
                    })
            });
            policy::task_visible(true, task.thread_id.is_some(), thread_space_visible)
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_files, public)]
pub fn visible_files(ctx: &ViewContext) -> Vec<VisibleFile> {
    accessible_spaces(ctx)
        .into_iter()
        .flat_map(|space| ctx.db.file_record().space_id().filter(space.id))
        .map(VisibleFile::from)
        .collect()
}

#[spacetimedb::view(accessor = my_file_uploads, public)]
pub fn my_file_uploads(ctx: &ViewContext) -> Vec<FileUpload> {
    ctx.db
        .file_upload()
        .owner_identity()
        .filter(ctx.sender())
        .filter(|upload| {
            !upload.completed && can_read_workspace(ctx, upload.workspace_id, ctx.sender())
        })
        .collect()
}

#[spacetimedb::view(accessor = my_notifications, public)]
pub fn my_notifications(ctx: &ViewContext) -> Vec<Notification> {
    ctx.db
        .notification()
        .recipient_identity()
        .filter(ctx.sender())
        .filter(|row| {
            if !can_read_workspace(ctx, row.workspace_id, ctx.sender()) {
                return false;
            }
            if row.resource_type == "task" {
                return ctx
                    .db
                    .task_item()
                    .id()
                    .find(row.resource_id)
                    .is_some_and(|task| {
                        task.workspace_id == row.workspace_id
                            && task.thread_id.is_none_or(|thread_id| {
                                ctx.db
                                    .named_thread()
                                    .id()
                                    .find(thread_id)
                                    .is_some_and(|thread| {
                                        visible_space(ctx, thread.space_id).is_some()
                                    })
                            })
                    });
            }
            if row.resource_type == "post" {
                return ctx
                    .db
                    .post()
                    .id()
                    .find(row.resource_id)
                    .is_some_and(|post| {
                        post.workspace_id == row.workspace_id
                            && !post.deleted
                            && visible_space(ctx, post.space_id).is_some()
                    });
            }
            false
        })
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_installations, public)]
pub fn visible_agent_installations(ctx: &ViewContext) -> Vec<VisibleAgentInstallation> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .agent_installation()
                .workspace_id()
                .filter(member.workspace_id)
        })
        .map(VisibleAgentInstallation::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_scopes, public)]
pub fn visible_agent_scopes(ctx: &ViewContext) -> Vec<VisibleAgentScope> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .agent_installation()
                .workspace_id()
                .filter(member.workspace_id)
        })
        .flat_map(|installation| {
            ctx.db
                .agent_scope()
                .installation_id()
                .filter(installation.id)
        })
        .map(VisibleAgentScope::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_tool_policies, public)]
pub fn visible_agent_tool_policies(ctx: &ViewContext) -> Vec<VisibleAgentToolPolicy> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active)
        .flat_map(|member| {
            ctx.db
                .agent_installation()
                .workspace_id()
                .filter(member.workspace_id)
        })
        .flat_map(|installation| {
            ctx.db
                .agent_tool_policy()
                .installation_id()
                .filter(installation.id)
        })
        .map(VisibleAgentToolPolicy::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_runs, public)]
pub fn visible_agent_runs(ctx: &ViewContext) -> Vec<VisibleAgentRun> {
    accessible_runs(ctx)
        .into_iter()
        .map(VisibleAgentRun::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_run_events, public)]
pub fn visible_agent_run_events(ctx: &ViewContext) -> Vec<AgentRunEvent> {
    accessible_runs(ctx)
        .into_iter()
        .flat_map(|run| ctx.db.agent_run_event().run_id().filter(run.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_context_manifests, public)]
pub fn visible_agent_context_manifests(ctx: &ViewContext) -> Vec<AgentContextManifest> {
    accessible_runs(ctx)
        .into_iter()
        .flat_map(|run| ctx.db.agent_context_manifest().run_id().filter(run.id))
        .collect()
}

#[spacetimedb::view(accessor = visible_agent_tool_calls, public)]
pub fn visible_agent_tool_calls(ctx: &ViewContext) -> Vec<VisibleAgentToolCall> {
    accessible_runs(ctx)
        .into_iter()
        .flat_map(|run| ctx.db.agent_tool_call().run_id().filter(run.id))
        .map(VisibleAgentToolCall::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_approvals, public)]
pub fn visible_approvals(ctx: &ViewContext) -> Vec<VisibleApproval> {
    accessible_runs(ctx)
        .into_iter()
        .filter(|run| {
            run.initiated_by == ctx.sender()
                || find_membership(ctx, run.workspace_id, ctx.sender())
                    .is_some_and(|member| role_allows(member.role, Action::ManageAgents))
        })
        .flat_map(|run| ctx.db.approval_request().run_id().filter(run.id))
        .map(VisibleApproval::from)
        .collect()
}

#[spacetimedb::view(accessor = visible_audit_log, public)]
pub fn visible_audit_log(ctx: &ViewContext) -> Vec<AuditLog> {
    ctx.db
        .workspace_member()
        .identity()
        .filter(ctx.sender())
        .filter(|member| member.active && role_allows(member.role, Action::ManageWorkspace))
        .flat_map(|member| {
            ctx.db
                .audit_log()
                .workspace_id()
                .filter(member.workspace_id)
        })
        .filter(|row| direct_resource_visible(ctx, &row.resource_type, row.resource_id))
        .collect()
}

#[spacetimedb::view(accessor = my_command_receipts, public)]
pub fn my_command_receipts(ctx: &ViewContext) -> Vec<VisibleCommandReceipt> {
    ctx.db
        .command_receipt()
        .actor_identity()
        .filter(ctx.sender())
        .filter(|receipt| {
            receipt
                .workspace_id
                .is_none_or(|workspace_id| can_read_workspace(ctx, workspace_id, ctx.sender()))
        })
        .filter(|receipt| {
            if receipt.result_type == "direct_conversation"
                || receipt.result_type == "direct_read_state"
            {
                direct_resource_visible(ctx, "direct_conversation", receipt.result_id)
            } else if receipt.result_type == "direct_message" {
                direct_resource_visible(ctx, "direct_message", receipt.result_id)
            } else if receipt.result_type == "dm_promotion" {
                direct_resource_visible(ctx, "dm_promotion", receipt.result_id)
            } else {
                true
            }
        })
        .map(VisibleCommandReceipt::from)
        .collect()
}

#[spacetimedb::view(accessor = agent_work_queue, public)]
pub fn agent_work_queue(ctx: &ViewContext) -> Vec<AgentRun> {
    let allowed = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_some_and(|service| service.enabled && service.can_run_agents);
    if !allowed {
        return vec![];
    }
    ctx.db
        .service_grant()
        .service_identity()
        .filter(ctx.sender())
        .filter(|grant| grant.enabled && grant.kind == "agent.run")
        .flat_map(|grant| ctx.db.agent_run().workspace_id().filter(grant.workspace_id))
        .filter(|run| {
            !matches!(
                run.state,
                AgentRunState::Succeeded
                    | AgentRunState::Failed
                    | AgentRunState::Canceled
                    | AgentRunState::Expired
                    | AgentRunState::Revoked
            )
        })
        .collect()
}

#[spacetimedb::view(accessor = agent_context_candidates, public)]
pub fn agent_context_candidates(ctx: &ViewContext) -> Vec<AgentContextCandidate> {
    let enabled = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_some_and(|service| service.enabled && service.can_run_agents);
    if !enabled {
        return vec![];
    }
    let mut result = Vec::new();
    for grant in ctx
        .db
        .service_grant()
        .service_identity()
        .filter(ctx.sender())
        .filter(|grant| grant.enabled && grant.kind == "agent.run")
    {
        for run in ctx
            .db
            .agent_run()
            .workspace_id()
            .filter(grant.workspace_id)
            .filter(|run| run.lease_owner == Some(ctx.sender()))
        {
            let Some(thread_id) = run.thread_id else {
                continue;
            };
            let Some(thread) = ctx.db.named_thread().id().find(thread_id) else {
                continue;
            };
            let mut candidates = Vec::new();
            if let Some(post) = ctx
                .db
                .post()
                .id()
                .find(thread.root_post_id)
                .filter(|post| !post.deleted && post.space_id == run.space_id)
            {
                candidates.push(AgentContextCandidate {
                    run_id: run.id,
                    resource_type: "post".into(),
                    resource_id: post.id,
                    resource_revision: post.revision,
                    title: post.title,
                    body: post.body,
                    created_at: post.created_at,
                });
            }
            let history_enabled = [Some(run.space_id), None].into_iter().any(|space_id| {
                ctx.db
                    .agent_scope()
                    .key()
                    .find(agent_scope_key(
                        run.installation_id,
                        space_id,
                        AgentCapability::ReadHistory,
                    ))
                    .is_some_and(|scope| scope.enabled)
            });
            if history_enabled {
                for contribution in ctx
                    .db
                    .contribution()
                    .thread_id()
                    .filter(thread_id)
                    .filter(|contribution| !contribution.deleted)
                {
                    candidates.push(AgentContextCandidate {
                        run_id: run.id,
                        resource_type: "contribution".into(),
                        resource_id: contribution.id,
                        resource_revision: contribution.revision,
                        title: thread.title.clone(),
                        body: contribution.body,
                        created_at: contribution.created_at,
                    });
                }
            }
            candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.created_at));
            candidates.truncate(64);
            result.extend(candidates);
        }
    }
    result
}

#[spacetimedb::view(accessor = pending_outbox_work, public)]
pub fn pending_outbox_work(ctx: &ViewContext) -> Vec<OutboxJobEnvelopeView> {
    let allowed = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_some_and(|service| service.enabled && service.can_process_outbox);
    if !allowed {
        return vec![];
    }
    ctx.db
        .service_grant()
        .service_identity()
        .filter(ctx.sender())
        .filter(|grant| grant.enabled)
        .flat_map(|grant| {
            ctx.db
                .outbox_job()
                .workspace_id()
                .filter(grant.workspace_id)
                .filter(move |job| job.kind == grant.kind)
        })
        .filter(|job| {
            matches!(
                job.state,
                OutboxState::Pending
                    | OutboxState::Retry
                    | OutboxState::OutcomeUnknown
                    | OutboxState::Leased
            )
        })
        .map(|job| OutboxJobEnvelopeView {
            id: job.id,
            workspace_id: job.workspace_id,
            kind: job.kind,
            effect_key: job.effect_key,
            resource_type: job.resource_type,
            resource_id: job.resource_id,
            resource_revision: job.resource_revision,
            acl_revision: job.acl_revision,
            intent_id: job.intent_id,
            recipient_id: job.recipient_id,
            channel: job.channel,
            authorization_epoch: job.authorization_epoch,
            minimal_message: job.minimal_message,
            payload_resource_id: job.payload_resource_id,
            rebuild_id: job.rebuild_id,
            generation: job.generation,
            file_id: job.file_id,
            version: job.version,
            run_id: job.run_id,
            created_at: job.created_at,
            next_attempt_at: job.next_attempt_at,
            attempt: job.attempt,
            state: job.state,
            lease_owner: job.lease_owner,
            worker_slot_id: job.worker_slot_id,
            lease_until: job.lease_until,
            lease_generation: job.lease_generation,
            last_error: job.last_error,
        })
        .collect()
}

#[spacetimedb::view(accessor = pending_notification_delivery_plans, public)]
pub fn pending_notification_delivery_plans(ctx: &ViewContext) -> Vec<NotificationDeliveryPlanView> {
    let allowed = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_some_and(|service| service.enabled && service.can_process_outbox);
    if !allowed {
        return vec![];
    }
    ctx.db
        .service_grant()
        .service_identity()
        .filter(ctx.sender())
        .filter(|grant| grant.enabled && grant.kind == "notification.deliver")
        .flat_map(|grant| {
            ctx.db
                .outbox_job()
                .workspace_id()
                .filter(grant.workspace_id)
                .filter(|job| {
                    job.kind == "notification.deliver"
                        && job.state == OutboxState::Leased
                        && job.lease_owner == Some(ctx.sender())
                })
        })
        .filter_map(|job| {
            let notification = ctx.db.notification().id().find(job.resource_id)?;
            let control = ctx
                .db
                .notification_control()
                .notification_id()
                .find(notification.id)?;
            let snapshot =
                crate::reducers::notification_authority_snapshot(ctx, &notification, &control);
            let exact_job_binding = policy::notification_delivery_binding_valid(&[
                job.resource_type == "notification",
                job.intent_id == Some(notification.id),
                job.recipient_id == Some(control.recipient_identity),
                job.payload_resource_id == Some(control.resource_id),
                job.authorization_epoch == Some(control.membership_epoch),
                job.resource_revision == control.group_revision,
                job.version == Some(control.group_revision),
                job.channel == control.channel,
                job.minimal_message == notification.summary,
            ]);
            let permit = ctx
                .db
                .notification_delivery_permit()
                .job_id()
                .find(job.id)
                .filter(|permit| {
                    exact_job_binding
                        && permit.service_identity == ctx.sender()
                        && permit.worker_slot_id == job.worker_slot_id
                        && permit.lease_generation == job.lease_generation
                        && permit.notification_id == notification.id
                        && permit.workspace_id == job.workspace_id
                        && permit.group_key == control.group_key
                        && permit.group_revision == control.group_revision
                        && permit.resource_revision == control.resource_revision
                        && permit.membership_epoch == control.membership_epoch
                        && permit.preference_revision == control.preference_revision
                        && permit.channel == control.channel
                });
            let delivery_state = if !exact_job_binding
                || snapshot.delivery_state == NotificationDeliveryState::Suppressed
            {
                NotificationDeliveryState::Suppressed
            } else {
                NotificationDeliveryState::Pending
            };
            Some(NotificationDeliveryPlanView {
                job_id: job.id,
                notification_id: notification.id,
                workspace_id: job.workspace_id,
                recipient_identity: control.recipient_identity,
                channel: control.channel,
                delivery_state,
                suppression_reason: if exact_job_binding {
                    snapshot.suppression_reason
                } else {
                    "job_binding_stale".into()
                },
                group_key: control.group_key,
                group_revision: control.group_revision,
                resource_type: control.resource_type,
                resource_id: control.resource_id,
                resource_revision: snapshot.resource_revision,
                membership_epoch: snapshot.membership_epoch,
                preference_revision: snapshot.preference_revision,
                lease_owner: job.lease_owner,
                worker_slot_id: job.worker_slot_id,
                lease_generation: job.lease_generation,
                permit_expires_at: permit.map(|permit| permit.expires_at),
            })
        })
        .collect()
}

#[spacetimedb::view(accessor = pending_post_search_documents, public)]
pub fn pending_post_search_documents(ctx: &ViewContext) -> Vec<SearchWorkItem> {
    let allowed = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_some_and(|service| service.enabled && service.can_process_outbox);
    if !allowed {
        return vec![];
    }
    ctx.db
        .service_grant()
        .service_identity()
        .filter(ctx.sender())
        .filter(|grant| {
            grant.enabled && matches!(grant.kind.as_str(), "search.upsert" | "search.tombstone")
        })
        .flat_map(|grant| {
            ctx.db
                .outbox_job()
                .workspace_id()
                .filter(grant.workspace_id)
                .filter(move |job| job.kind == grant.kind)
        })
        .filter(|job| {
            matches!(
                job.state,
                OutboxState::Pending | OutboxState::Retry | OutboxState::OutcomeUnknown
            ) || (job.state == OutboxState::Leased && job.lease_owner == Some(ctx.sender()))
        })
        .filter_map(|job| {
            ctx.db
                .search_document_snapshot()
                .effect_key()
                .find(job.effect_key.clone())
                .filter(|snapshot| {
                    policy::search_snapshot_matches_job(
                        snapshot.workspace_id == job.workspace_id,
                        snapshot.effect_key == job.effect_key,
                        snapshot.resource_revision == job.resource_revision,
                        job.acl_revision == Some(snapshot.acl_revision),
                    )
                })
                .map(|snapshot| SearchWorkItem {
                    job_id: job.id,
                    effect_key: job.effect_key,
                    workspace_id: snapshot.workspace_id,
                    space_id: snapshot.space_id,
                    resource_type: snapshot.resource_type,
                    resource_id: snapshot.resource_id,
                    resource_revision: snapshot.resource_revision,
                    acl_revision: snapshot.acl_revision,
                    title: snapshot.title,
                    body: snapshot.body,
                    tombstone: snapshot.tombstone,
                    allowed_identities: snapshot.allowed_identities,
                    state: job.state,
                    lease_generation: job.lease_generation,
                })
        })
        .collect()
}

#[spacetimedb::view(accessor = file_processing_plans, public)]
pub fn file_processing_plans(ctx: &ViewContext) -> Vec<FileProcessingPlanView> {
    let enabled = ctx
        .db
        .service_principal()
        .identity()
        .find(ctx.sender())
        .is_some_and(|service| service.enabled && service.can_process_outbox);
    if !enabled {
        return vec![];
    }
    ctx.db
        .service_grant()
        .service_identity()
        .filter(ctx.sender())
        .filter(|grant| {
            grant.enabled
                && matches!(
                    grant.kind.as_str(),
                    "file.scan" | "file.extract" | "file.cleanup"
                )
        })
        .flat_map(|grant| {
            ctx.db
                .outbox_job()
                .workspace_id()
                .filter(grant.workspace_id)
                .filter(move |job| job.kind == grant.kind)
        })
        .filter(|job| {
            matches!(
                job.state,
                OutboxState::Pending | OutboxState::Retry | OutboxState::OutcomeUnknown
            ) || (job.state == OutboxState::Leased && job.lease_owner == Some(ctx.sender()))
        })
        .filter_map(|job| {
            ctx.db
                .file_record()
                .id()
                .find(job.resource_id)
                .filter(|file| {
                    file.workspace_id == job.workspace_id && file.revision >= job.resource_revision
                })
                .map(|file| FileProcessingPlanView {
                    job_id: job.id,
                    workspace_id: file.workspace_id,
                    space_id: file.space_id,
                    file_id: file.id,
                    file_revision: file.revision,
                    kind: job.kind,
                    source_key: if file.clean_key.is_empty() {
                        file.source_key.clone()
                    } else {
                        file.clean_key.clone()
                    },
                    clean_destination_key: format!("clean/{}/{}/1", file.workspace_id, file.id),
                    cleanup_prefix: file.cleanup_prefix,
                    max_bytes: file.declared_size_bytes,
                    max_extracted_characters: 100_000,
                    allowed_types: vec![
                        "text/plain".into(),
                        "application/pdf".into(),
                        "image/png".into(),
                        "image/jpeg".into(),
                    ],
                    state: file.state,
                    lease_generation: job.lease_generation,
                })
        })
        .collect()
}
