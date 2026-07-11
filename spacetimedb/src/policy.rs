#![cfg_attr(not(feature = "module"), allow(dead_code))]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyRole {
    Owner,
    Admin,
    Member,
    Guest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyAction {
    Read,
    Write,
    CreateSpace,
    ManageMembers,
    ManageWorkspace,
    ManageAgents,
    RunAgent,
    RecordDecisionOrTask,
}

pub(crate) fn role_allows(role: PolicyRole, action: PolicyAction) -> bool {
    match role {
        PolicyRole::Owner | PolicyRole::Admin => true,
        PolicyRole::Member => matches!(
            action,
            PolicyAction::Read
                | PolicyAction::Write
                | PolicyAction::RunAgent
                | PolicyAction::RecordDecisionOrTask
        ),
        PolicyRole::Guest => matches!(action, PolicyAction::Read | PolicyAction::Write),
    }
}

pub(crate) fn membership_allows<T: Eq>(
    membership_workspace: T,
    target_workspace: T,
    role: PolicyRole,
    active: bool,
    action: PolicyAction,
) -> bool {
    active && membership_workspace == target_workspace && role_allows(role, action)
}

pub(crate) fn private_space_allows(
    workspace_allowed: bool,
    is_private: bool,
    explicit_space_membership: bool,
) -> bool {
    workspace_allowed && (!is_private || explicit_space_membership)
}

pub(crate) fn task_visible(
    workspace_allowed: bool,
    attached_to_thread: bool,
    thread_space_visible: bool,
) -> bool {
    workspace_allowed && (!attached_to_thread || thread_space_visible)
}

pub(crate) fn tool_policy_valid(is_external: bool, requires_approval: bool) -> bool {
    !is_external || requires_approval
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyAgentState {
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

pub(crate) fn agent_event_transition_allowed(
    current: PolicyAgentState,
    next: PolicyAgentState,
) -> bool {
    matches!(
        (current, next),
        (PolicyAgentState::Authorizing, PolicyAgentState::Authorizing)
            | (
                PolicyAgentState::Authorizing,
                PolicyAgentState::CollectingContext
            )
            | (
                PolicyAgentState::CollectingContext,
                PolicyAgentState::CollectingContext
            )
            | (
                PolicyAgentState::CollectingContext,
                PolicyAgentState::Running
            )
            | (PolicyAgentState::Running, PolicyAgentState::Running)
    )
}

pub(crate) fn lease_claimable(
    terminal: bool,
    queued: bool,
    lease_expired: bool,
    attempts: u32,
    max_attempts: u32,
    age_seconds: u64,
    max_age_seconds: u64,
) -> bool {
    !terminal
        && (queued || lease_expired)
        && attempts < max_attempts
        && age_seconds <= max_age_seconds
}

pub(crate) fn command_replay_matches(same_workspace: bool, same_input_hash: bool) -> bool {
    same_workspace && same_input_hash
}

pub(crate) fn bootstrap_configuration_valid(
    issuer: Option<&str>,
    audience: Option<&str>,
    owner_subject: Option<&str>,
) -> bool {
    let Some(issuer) = issuer else {
        return false;
    };
    let Some(audience) = audience else {
        return false;
    };
    let Some(owner_subject) = owner_subject else {
        return false;
    };

    let valid_text = |value: &str, max_len: usize| {
        !value.is_empty()
            && value.len() <= max_len
            && value.trim() == value
            && !value.chars().any(char::is_control)
    };
    valid_text(issuer, 500)
        && oidc_issuer_valid(issuer)
        && valid_text(audience, 255)
        && !audience.chars().any(char::is_whitespace)
        && valid_text(owner_subject, 255)
        && !owner_subject.chars().any(char::is_whitespace)
}

fn oidc_issuer_valid(issuer: &str) -> bool {
    if issuer.chars().any(char::is_whitespace) || issuer.contains(['\\', '%', '?', '#', '@']) {
        return false;
    }

    let Some((scheme, remainder)) = issuer.split_once("://") else {
        return false;
    };
    if remainder.is_empty() {
        return false;
    }
    let (authority, _path) = remainder.split_once('/').unwrap_or((remainder, ""));
    let Some(host) = valid_url_authority_host(authority) else {
        return false;
    };

    match scheme {
        "https" => true,
        "http" => host.eq_ignore_ascii_case("localhost"),
        _ => false,
    }
}

fn valid_url_authority_host(authority: &str) -> Option<&str> {
    if authority.is_empty() {
        return None;
    }

    if authority.starts_with('[') {
        let close = authority.find(']')?;
        let host = &authority[..=close];
        let address = &host[1..host.len() - 1];
        if address.parse::<std::net::Ipv6Addr>().is_err() {
            return None;
        }
        let suffix = &authority[close + 1..];
        if !suffix.is_empty() && !valid_url_port(suffix.strip_prefix(':')?) {
            return None;
        }
        return Some(host);
    }

    if authority.matches(':').count() > 1 {
        return None;
    }
    let (host, port) = authority
        .rsplit_once(':')
        .map_or((authority, None), |(host, port)| (host, Some(port)));
    if host.is_empty()
        || host.starts_with('.')
        || host.ends_with('.')
        || host.starts_with('-')
        || host.ends_with('-')
        || !host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
        || host.split('.').any(|label| label.is_empty())
        || port.is_some_and(|port| !valid_url_port(port))
    {
        return None;
    }
    Some(host)
}

fn valid_url_port(port: &str) -> bool {
    !port.is_empty()
        && port.chars().all(|character| character.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlatformUpdateAction {
    Noop,
    ProvisionBootstrap,
    BackfillPlatformAuthority,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PlatformUpdateState {
    pub has_platform_authority: bool,
    pub has_auth_policy: bool,
    pub has_bootstrap_authority: bool,
    pub bootstrap_consumed: bool,
    pub policy_matches_bootstrap: bool,
    pub has_application_state: bool,
}

pub(crate) fn classify_platform_update(
    state: PlatformUpdateState,
) -> Result<PlatformUpdateAction, &'static str> {
    if state.has_platform_authority {
        return if state.has_auth_policy
            && state.has_bootstrap_authority
            && state.bootstrap_consumed
            && state.policy_matches_bootstrap
        {
            Ok(PlatformUpdateAction::Noop)
        } else {
            Err("platform authority exists without a consistent consumed bootstrap and auth policy")
        };
    }

    match (state.has_auth_policy, state.has_bootstrap_authority) {
        (false, false) if !state.has_application_state => {
            Ok(PlatformUpdateAction::ProvisionBootstrap)
        }
        (false, true) if !state.bootstrap_consumed && !state.has_application_state => {
            Ok(PlatformUpdateAction::Noop)
        }
        (true, true) if state.bootstrap_consumed && state.policy_matches_bootstrap => {
            Ok(PlatformUpdateAction::BackfillPlatformAuthority)
        }
        _ => Err("authority state is partial, ambiguous, or inconsistent"),
    }
}

pub(crate) fn platform_operator_allows(expected_subject: &str, actual_subject: &str) -> bool {
    expected_subject == actual_subject
}

pub(crate) fn oidc_subject_valid(subject: &str) -> bool {
    !subject.is_empty()
        && subject.len() <= 255
        && subject.trim() == subject
        && !subject
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}

pub(crate) fn platform_change_allowed(
    is_current_operator: bool,
    actual_revision: u64,
    expected_revision: u64,
) -> bool {
    is_current_operator && actual_revision == expected_revision
}

pub(crate) fn service_provision_allowed(
    is_current_operator: bool,
    workspace_scope_valid: bool,
) -> bool {
    is_current_operator && workspace_scope_valid
}

pub(crate) fn service_runtime_scope_allows(
    can_run_agents: bool,
    can_process_outbox: bool,
    agent_operation: bool,
) -> bool {
    if agent_operation {
        can_run_agents
    } else {
        can_process_outbox
    }
}

pub(crate) fn bootstrap_subject_allowed(expected_subject: &str, actual_subject: &str) -> bool {
    expected_subject == actual_subject
}

pub(crate) fn reply_depth_allowed(parent_depth: u32, max_depth: u32) -> bool {
    parent_depth < max_depth
}

pub(crate) fn agent_completion_allowed(
    running: bool,
    has_unfinished_or_unknown_work: bool,
) -> bool {
    running && !has_unfinished_or_unknown_work
}

pub(crate) fn approval_decision_allowed(
    active_membership: bool,
    run_awaiting_approval: bool,
    run_canceled_or_terminal: bool,
    epochs_current: bool,
    approval_pending_and_unexpired: bool,
) -> bool {
    active_membership
        && run_awaiting_approval
        && !run_canceled_or_terminal
        && epochs_current
        && approval_pending_and_unexpired
}

pub(crate) fn scoped_service_grant_allows(
    service_enabled: bool,
    grant_enabled: bool,
    same_workspace: bool,
    same_kind: bool,
) -> bool {
    service_enabled && grant_enabled && same_workspace && same_kind
}

pub(crate) fn search_snapshot_matches_job(
    same_workspace: bool,
    same_effect_key: bool,
    same_resource_revision: bool,
) -> bool {
    same_workspace && same_effect_key && same_resource_revision
}

pub(crate) fn trusted_tool_binding_valid(effect_is_read: bool, capability_is_read: bool) -> bool {
    effect_is_read == capability_is_read
}

pub(crate) fn trusted_tool_policy_current(
    catalog_enabled: bool,
    catalog_revision: u64,
    pinned_revision: u64,
    capability_matches: bool,
    effect_class_matches: bool,
) -> bool {
    catalog_enabled
        && catalog_revision == pinned_revision
        && capability_matches
        && effect_class_matches
}

#[derive(Clone, Copy)]
pub(crate) struct TrustedToolExecutionState {
    pub policy_enabled: bool,
    pub policy_revision: u64,
    pub pinned_policy_revision: u64,
    pub catalog_enabled: bool,
    pub catalog_revision: u64,
    pub pinned_catalog_revision: u64,
    pub installation_matches: bool,
    pub tool_identity_matches: bool,
    pub capability_matches: bool,
    pub effect_class_matches: bool,
    pub approval_requirement_matches: bool,
}

pub(crate) fn trusted_tool_execution_current(state: TrustedToolExecutionState) -> bool {
    state.policy_enabled
        && state.policy_revision == state.pinned_policy_revision
        && state.catalog_enabled
        && state.catalog_revision == state.pinned_catalog_revision
        && state.installation_matches
        && state.tool_identity_matches
        && state.capability_matches
        && state.effect_class_matches
        && state.approval_requirement_matches
}

pub(crate) fn effect_commit_allowed(
    acquired: bool,
    owner_matches: bool,
    generation_matches: bool,
) -> bool {
    acquired && owner_matches && generation_matches
}

pub(crate) fn private_task_assignment_allowed(assignee_can_read_thread_space: bool) -> bool {
    assignee_can_read_thread_space
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyTaskState {
    Todo,
    InProgress,
    Done,
    Canceled,
}

pub(crate) fn task_transition_allowed(current: PolicyTaskState, next: PolicyTaskState) -> bool {
    matches!(
        (current, next),
        (PolicyTaskState::Todo, PolicyTaskState::InProgress)
            | (PolicyTaskState::Todo, PolicyTaskState::Canceled)
            | (PolicyTaskState::InProgress, PolicyTaskState::Done)
            | (PolicyTaskState::InProgress, PolicyTaskState::Canceled)
            | (PolicyTaskState::InProgress, PolicyTaskState::Todo)
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PolicyDecisionState {
    Proposed,
    Accepted,
    Rejected,
    Superseded,
}

pub(crate) fn decision_transition_allowed(
    current: PolicyDecisionState,
    next: PolicyDecisionState,
) -> bool {
    matches!(
        (current, next),
        (PolicyDecisionState::Proposed, PolicyDecisionState::Accepted)
            | (PolicyDecisionState::Proposed, PolicyDecisionState::Rejected)
            | (
                PolicyDecisionState::Proposed,
                PolicyDecisionState::Superseded
            )
            | (
                PolicyDecisionState::Accepted,
                PolicyDecisionState::Superseded
            )
            | (
                PolicyDecisionState::Rejected,
                PolicyDecisionState::Superseded
            )
    )
}

pub(crate) fn derived_actor<T: Copy>(sender: T, _untrusted_claimed_actor: T) -> T {
    sender
}

pub(crate) fn revision_matches(actual: u64, expected: u64) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "stale revision: expected {expected}, current revision is {actual}"
        ))
    }
}

pub(crate) fn is_duplicate_receipt<T: Eq, U: Eq>(
    receipt_actor: T,
    sender: T,
    receipt_operation: &str,
    operation: &str,
    receipt_request: U,
    request_id: U,
) -> bool {
    receipt_actor == sender && receipt_operation == operation && receipt_request == request_id
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AgentGate<T> {
    pub installation_enabled: bool,
    pub captured_installation_epoch: u64,
    pub current_installation_epoch: u64,
    pub captured_membership_epoch: u64,
    pub current_membership_epoch: u64,
    pub cancel_requested: bool,
    pub expected_lease_owner: T,
    pub caller: T,
    pub expected_lease_generation: u64,
    pub supplied_lease_generation: u64,
    pub approval_required: bool,
    pub approval_valid: bool,
}

pub(crate) fn agent_gate_allows<T: Eq>(gate: AgentGate<T>) -> bool {
    gate.installation_enabled
        && gate.captured_installation_epoch == gate.current_installation_epoch
        && gate.captured_membership_epoch == gate.current_membership_epoch
        && !gate.cancel_requested
        && gate.expected_lease_owner == gate.caller
        && gate.expected_lease_generation == gate.supplied_lease_generation
        && (!gate.approval_required || gate.approval_valid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named_thread_identity_available<PostId, ThreadId: Eq>(
        existing: &[(PostId, ThreadId)],
        candidate_thread_id: &ThreadId,
    ) -> bool {
        existing
            .iter()
            .all(|(_, thread_id)| thread_id != candidate_thread_id)
    }

    #[test]
    fn tenant_isolation_rejects_foreign_workspace_even_for_admin() {
        assert!(!membership_allows(
            1_u64,
            2_u64,
            PolicyRole::Admin,
            true,
            PolicyAction::Read,
        ));
    }

    #[test]
    fn impersonation_is_prevented_by_server_derived_actor() {
        assert_eq!(derived_actor(11_u64, 99_u64), 11_u64);
    }

    #[test]
    fn roles_and_private_spaces_are_deny_by_default() {
        assert!(!role_allows(
            PolicyRole::Member,
            PolicyAction::ManageMembers
        ));
        assert!(role_allows(PolicyRole::Member, PolicyAction::Write));
        assert!(!private_space_allows(true, true, false));
        assert!(private_space_allows(true, true, true));
    }

    #[test]
    fn two_named_thread_identities_are_allowed_for_one_post() {
        let existing = vec![(41_u64, 100_u64)];
        assert!(named_thread_identity_available(&existing, &101_u64));
        assert!(!named_thread_identity_available(&existing, &100_u64));
    }

    #[test]
    fn private_thread_task_visibility_requires_space_membership() {
        assert!(!task_visible(true, true, false));
        assert!(task_visible(true, true, true));
        assert!(task_visible(true, false, false));
    }

    #[test]
    fn external_tool_policy_cannot_disable_approval() {
        assert!(!tool_policy_valid(true, false));
        assert!(tool_policy_valid(true, true));
        assert!(tool_policy_valid(false, false));
    }

    #[test]
    fn duplicate_commands_are_scoped_to_actor_operation_and_request() {
        assert!(is_duplicate_receipt(
            7_u64,
            7_u64,
            "create_post",
            "create_post",
            42_u128,
            42_u128,
        ));
        assert!(!is_duplicate_receipt(
            7_u64,
            8_u64,
            "create_post",
            "create_post",
            42_u128,
            42_u128,
        ));
    }

    #[test]
    fn stale_revisions_are_rejected() {
        assert!(revision_matches(4, 4).is_ok());
        assert!(revision_matches(5, 4).is_err());
    }

    #[test]
    fn membership_revocation_denies_prior_owner_role() {
        assert!(!membership_allows(
            1_u64,
            1_u64,
            PolicyRole::Owner,
            false,
            PolicyAction::ManageWorkspace,
        ));
    }

    #[test]
    fn agent_commit_requires_current_epochs_lease_and_approval() {
        let base = AgentGate {
            installation_enabled: true,
            captured_installation_epoch: 8,
            current_installation_epoch: 8,
            captured_membership_epoch: 3,
            current_membership_epoch: 3,
            cancel_requested: false,
            expected_lease_owner: 9_u64,
            caller: 9_u64,
            expected_lease_generation: 2,
            supplied_lease_generation: 2,
            approval_required: true,
            approval_valid: true,
        };
        assert!(agent_gate_allows(base));
        assert!(!agent_gate_allows(AgentGate {
            current_installation_epoch: 9,
            ..base
        }));
        assert!(!agent_gate_allows(AgentGate {
            approval_valid: false,
            ..base
        }));
        assert!(!agent_gate_allows(AgentGate {
            supplied_lease_generation: 1,
            ..base
        }));
    }

    #[test]
    fn agent_event_transition_matrix_rejects_skips_and_terminal_resurrection() {
        assert!(agent_event_transition_allowed(
            PolicyAgentState::Authorizing,
            PolicyAgentState::CollectingContext,
        ));
        assert!(agent_event_transition_allowed(
            PolicyAgentState::CollectingContext,
            PolicyAgentState::Running,
        ));
        assert!(!agent_event_transition_allowed(
            PolicyAgentState::Running,
            PolicyAgentState::ExecutingTool,
        ));
        assert!(!agent_event_transition_allowed(
            PolicyAgentState::AwaitingApproval,
            PolicyAgentState::Running,
        ));
        assert!(!agent_event_transition_allowed(
            PolicyAgentState::Succeeded,
            PolicyAgentState::Running,
        ));
    }

    #[test]
    fn expired_nonterminal_leases_are_reclaimable_within_limits() {
        assert!(lease_claimable(false, false, true, 1, 3, 30, 60));
        assert!(!lease_claimable(false, false, false, 1, 3, 30, 60));
        assert!(!lease_claimable(false, false, true, 3, 3, 30, 60));
        assert!(!lease_claimable(true, false, true, 1, 3, 30, 60));
    }

    #[test]
    fn receipt_replay_requires_workspace_and_input_hash_match() {
        assert!(command_replay_matches(true, true));
        assert!(!command_replay_matches(false, true));
        assert!(!command_replay_matches(true, false));
    }

    #[test]
    fn bootstrap_requires_complete_canonical_build_configuration() {
        assert!(bootstrap_configuration_valid(
            Some("https://issuer.example"),
            Some("project-conversation-production"),
            Some("oidc|owner-123"),
        ));
        assert!(bootstrap_configuration_valid(
            Some("http://localhost:5556"),
            Some("project-conversation-local"),
            Some("local-owner"),
        ));
        assert!(!bootstrap_configuration_valid(
            None,
            Some("project-conversation-production"),
            Some("oidc|owner-123"),
        ));
        assert!(!bootstrap_configuration_valid(
            Some("https://issuer.example"),
            Some("project conversation production"),
            Some("oidc|owner-123"),
        ));
        assert!(!bootstrap_configuration_valid(
            Some("https://issuer.example"),
            Some("project-conversation-production"),
            Some("owner subject"),
        ));
        assert!(!bootstrap_configuration_valid(
            Some("http://localhost.evil.example"),
            Some("project-conversation-production"),
            Some("oidc|owner-123"),
        ));
        assert!(!bootstrap_configuration_valid(
            Some("https://"),
            Some("project-conversation-production"),
            Some("oidc|owner-123"),
        ));
        assert!(bootstrap_subject_allowed(
            "oidc|owner-123",
            "oidc|owner-123"
        ));
        assert!(!bootstrap_subject_allowed(
            "oidc|owner-123",
            "oidc|attacker"
        ));
    }

    #[test]
    fn bootstrap_issuer_parser_rejects_authority_confusion_and_url_metadata() {
        let valid = |issuer| {
            bootstrap_configuration_valid(
                Some(issuer),
                Some("project-conversation-production"),
                Some("oidc|owner-123"),
            )
        };
        assert!(valid("https://issuer.example/tenant"));
        assert!(valid("https://issuer.example:8443/tenant"));
        assert!(valid("http://localhost:5556/tenant"));

        for issuer in [
            "http://localhost:80@evil.example",
            "http://localhost%2eevil.example",
            "http://localhost\\@evil.example",
            "http://localhost?redirect=https://evil.example",
            "http://localhost#evil",
            "http://localhost:",
            "http://localhost:not-a-port",
            "http://localhost:65536",
            "http://localhost:0",
            "https://user@issuer.example",
            "https://issuer.example?query=1",
            "https://issuer.example#fragment",
            "https://issuer.example\\evil",
            "https://issuer%2eexample",
            "https://issuer.example:",
            "https://issuer.example:abc",
            "https://issuer.example:99999",
        ] {
            assert!(!valid(issuer), "adversarial issuer accepted: {issuer}");
        }
    }

    #[test]
    fn platform_update_classification_is_fail_closed() {
        let empty = PlatformUpdateState {
            has_platform_authority: false,
            has_auth_policy: false,
            has_bootstrap_authority: false,
            bootstrap_consumed: false,
            policy_matches_bootstrap: false,
            has_application_state: false,
        };
        assert_eq!(
            classify_platform_update(empty),
            Ok(PlatformUpdateAction::ProvisionBootstrap)
        );
        assert!(
            classify_platform_update(PlatformUpdateState {
                has_application_state: true,
                ..empty
            })
            .is_err()
        );

        let legacy = PlatformUpdateState {
            has_auth_policy: true,
            has_bootstrap_authority: true,
            bootstrap_consumed: true,
            policy_matches_bootstrap: true,
            has_application_state: true,
            ..empty
        };
        assert_eq!(
            classify_platform_update(legacy),
            Ok(PlatformUpdateAction::BackfillPlatformAuthority)
        );
        assert!(
            classify_platform_update(PlatformUpdateState {
                policy_matches_bootstrap: false,
                ..legacy
            })
            .is_err()
        );
        assert_eq!(
            classify_platform_update(PlatformUpdateState {
                has_platform_authority: true,
                ..legacy
            }),
            Ok(PlatformUpdateAction::Noop)
        );
        assert!(
            classify_platform_update(PlatformUpdateState {
                has_platform_authority: true,
                policy_matches_bootstrap: false,
                ..legacy
            })
            .is_err()
        );
    }

    #[test]
    fn operator_rotation_and_transfer_require_current_subject_and_revision() {
        assert!(platform_operator_allows("owner-a", "owner-a"));
        assert!(!platform_operator_allows("owner-a", "owner-b"));
        assert!(platform_change_allowed(true, 7, 7));
        assert!(!platform_change_allowed(false, 7, 7));
        assert!(!platform_change_allowed(true, 8, 7));
    }

    #[test]
    fn service_provisioning_requires_platform_authority_and_valid_scope() {
        assert!(service_provision_allowed(true, true));
        assert!(!service_provision_allowed(false, true));
        assert!(!service_provision_allowed(true, false));
    }

    #[test]
    fn service_runtime_flags_are_not_interchangeable() {
        assert!(service_runtime_scope_allows(true, false, true));
        assert!(!service_runtime_scope_allows(false, true, true));
        assert!(service_runtime_scope_allows(false, true, false));
        assert!(!service_runtime_scope_allows(true, false, false));
    }

    #[test]
    fn reply_depth_is_strictly_bounded() {
        assert!(reply_depth_allowed(31, 32));
        assert!(!reply_depth_allowed(32, 32));
    }

    #[test]
    fn completion_rejects_pending_and_outcome_unknown_tool_work() {
        assert!(agent_completion_allowed(true, false));
        assert!(!agent_completion_allowed(true, true));
        assert!(!agent_completion_allowed(false, false));
    }

    #[test]
    fn approval_cannot_resurrect_revoked_or_membership_stale_run() {
        assert!(approval_decision_allowed(true, true, false, true, true));
        assert!(!approval_decision_allowed(false, true, false, true, true));
        assert!(!approval_decision_allowed(true, true, true, true, true));
        assert!(!approval_decision_allowed(true, true, false, false, true));
    }

    #[test]
    fn service_grants_are_both_workspace_and_kind_scoped() {
        assert!(scoped_service_grant_allows(true, true, true, true));
        assert!(!scoped_service_grant_allows(true, true, false, true));
        assert!(!scoped_service_grant_allows(true, true, true, false));
    }

    #[test]
    fn search_snapshot_must_match_job_revision_and_tenant() {
        assert!(search_snapshot_matches_job(true, true, true));
        assert!(!search_snapshot_matches_job(false, true, true));
        assert!(!search_snapshot_matches_job(true, true, false));
    }

    #[test]
    fn trusted_tool_catalog_prevents_destructive_as_read_configuration() {
        assert!(trusted_tool_binding_valid(true, true));
        assert!(trusted_tool_binding_valid(false, false));
        assert!(!trusted_tool_binding_valid(false, true));
    }

    #[test]
    fn trusted_catalog_disable_or_revision_change_fences_existing_policy() {
        assert!(trusted_tool_policy_current(true, 4, 4, true, true));
        assert!(!trusted_tool_policy_current(false, 4, 4, true, true));
        assert!(!trusted_tool_policy_current(true, 5, 4, true, true));
        assert!(!trusted_tool_policy_current(true, 4, 4, false, true));
        assert!(!trusted_tool_policy_current(true, 4, 4, true, false));
    }

    #[test]
    fn every_tool_effect_boundary_requires_the_exact_current_policy_and_catalog() {
        let current = TrustedToolExecutionState {
            policy_enabled: true,
            policy_revision: 7,
            pinned_policy_revision: 7,
            catalog_enabled: true,
            catalog_revision: 4,
            pinned_catalog_revision: 4,
            installation_matches: true,
            tool_identity_matches: true,
            capability_matches: true,
            effect_class_matches: true,
            approval_requirement_matches: true,
        };
        assert!(trusted_tool_execution_current(current));
        let cases = [
            TrustedToolExecutionState {
                policy_enabled: false,
                ..current
            },
            TrustedToolExecutionState {
                policy_revision: 8,
                ..current
            },
            TrustedToolExecutionState {
                catalog_enabled: false,
                ..current
            },
            TrustedToolExecutionState {
                catalog_revision: 5,
                ..current
            },
            TrustedToolExecutionState {
                installation_matches: false,
                ..current
            },
            TrustedToolExecutionState {
                tool_identity_matches: false,
                ..current
            },
            TrustedToolExecutionState {
                capability_matches: false,
                ..current
            },
            TrustedToolExecutionState {
                effect_class_matches: false,
                ..current
            },
            TrustedToolExecutionState {
                approval_requirement_matches: false,
                ..current
            },
        ];
        for case in cases {
            assert!(!trusted_tool_execution_current(case));
        }
    }

    #[test]
    fn effect_commit_requires_exact_acquisition_owner_and_generation() {
        assert!(effect_commit_allowed(true, true, true));
        assert!(!effect_commit_allowed(false, true, true));
        assert!(!effect_commit_allowed(true, false, true));
        assert!(!effect_commit_allowed(true, true, false));
    }

    #[test]
    fn private_task_assignment_requires_assignee_visibility() {
        assert!(private_task_assignment_allowed(true));
        assert!(!private_task_assignment_allowed(false));
    }

    #[test]
    fn task_and_decision_lifecycles_reject_terminal_resurrection() {
        assert!(task_transition_allowed(
            PolicyTaskState::Todo,
            PolicyTaskState::InProgress,
        ));
        assert!(task_transition_allowed(
            PolicyTaskState::InProgress,
            PolicyTaskState::Done,
        ));
        assert!(!task_transition_allowed(
            PolicyTaskState::Done,
            PolicyTaskState::Todo,
        ));
        assert!(decision_transition_allowed(
            PolicyDecisionState::Proposed,
            PolicyDecisionState::Accepted,
        ));
        assert!(!decision_transition_allowed(
            PolicyDecisionState::Superseded,
            PolicyDecisionState::Proposed,
        ));
    }
}
