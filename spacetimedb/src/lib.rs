#![forbid(unsafe_code)]

mod policy;

#[cfg(feature = "module")]
mod authz;
#[cfg(feature = "module")]
mod model;
#[cfg(feature = "module")]
mod reducers;
#[cfg(feature = "module")]
mod views;

#[cfg(feature = "module")]
pub use model::*;

#[cfg(test)]
mod reducer_contract_tests {
    use crate::policy::{
        PrivateDirectMessageOperation, PrivateDirectMessageTarget, PrivateReplayDisposition,
        clean_object_identity_valid, direct_message_replay_gate, direct_message_target_gate,
        file_deletion_reclaim_allowed, notification_coalesce_binding_valid,
        notification_delivery_allowed, notification_preference_valid, oidc_audience_valid,
        presence_authorizes, presence_heartbeat_valid, worker_effect_takeover_allowed,
    };

    fn assert_private_denial_equivalence(operation: PrivateDirectMessageOperation, expected: &str) {
        let observations = [
            (
                "changed-input receipt conflict",
                direct_message_replay_gate(operation, PrivateReplayDisposition::Conflict)
                    .expect_err("conflicting replay must be denied"),
            ),
            (
                "nonexistent target",
                direct_message_target_gate(operation, PrivateDirectMessageTarget::Nonexistent)
                    .expect_err("nonexistent target must be denied"),
            ),
            (
                "other-author target",
                direct_message_target_gate(operation, PrivateDirectMessageTarget::OtherAuthor)
                    .expect_err("foreign target must be denied"),
            ),
            (
                "revoked access",
                direct_message_target_gate(operation, PrivateDirectMessageTarget::AccessRevoked)
                    .expect_err("revoked access must be denied"),
            ),
            (
                "post-leave target",
                direct_message_target_gate(operation, PrivateDirectMessageTarget::AccessRevoked)
                    .expect_err("post-leave target must be denied"),
            ),
        ];
        for (case, observed) in observations {
            assert_eq!(observed, expected, "denial differed for {case}");
        }
        assert_eq!(
            direct_message_replay_gate(operation, PrivateReplayDisposition::Exact),
            Ok(true)
        );
    }

    #[test]
    fn edit_direct_message_reducer_denials_are_observationally_identical() {
        assert_private_denial_equivalence(
            PrivateDirectMessageOperation::Edit,
            "edit direct message unavailable",
        );
    }

    #[test]
    fn delete_direct_message_reducer_denials_are_observationally_identical() {
        assert_private_denial_equivalence(
            PrivateDirectMessageOperation::Delete,
            "delete direct message unavailable",
        );
    }

    #[test]
    fn presence_reducer_contract_is_bounded_and_non_authoritative() {
        assert!(presence_heartbeat_valid(60, "Desktop"));
        assert!(!presence_heartbeat_valid(301, "Desktop"));
        assert!(!presence_authorizes(true));
    }

    #[test]
    fn worker_effect_takeover_is_exact_and_clean_objects_are_version_bound() {
        assert!(worker_effect_takeover_allowed(true, false, false, false));
        assert!(!worker_effect_takeover_allowed(false, false, true, true));
        assert!(!worker_effect_takeover_allowed(false, true, false, false));
        assert!(worker_effect_takeover_allowed(false, true, true, false));
        assert!(worker_effect_takeover_allowed(false, true, false, true));

        let checksum = "a".repeat(64);
        assert!(clean_object_identity_valid("version-1", &checksum));
        assert!(!clean_object_identity_valid("", &checksum));
        assert!(!clean_object_identity_valid("version/1", &checksum));
        assert!(!clean_object_identity_valid("version-1", &"A".repeat(64)));
        assert!(!clean_object_identity_valid("version-1", "abc"));
    }

    #[test]
    fn oidc_audience_companions_are_exact_bounded_values() {
        assert!(oidc_audience_valid("client_01KNAKHWDENJZH10KDPEYAMZMN"));
        assert!(oidc_audience_valid("https://parrot.skylarenns.com"));
        assert!(!oidc_audience_valid(""));
        assert!(!oidc_audience_valid(" client"));
        assert!(!oidc_audience_valid("client one"));
        assert!(!oidc_audience_valid("client,other"));
        assert!(!oidc_audience_valid(&"a".repeat(256)));
    }

    #[test]
    fn file_deletion_claim_replay_and_crash_takeover_are_generation_fenced() {
        assert!(file_deletion_reclaim_allowed(false, false, true, false));
        assert!(!file_deletion_reclaim_allowed(false, false, false, false));
        assert!(file_deletion_reclaim_allowed(false, false, false, true));
        assert!(file_deletion_reclaim_allowed(false, true, false, false));
        assert!(!file_deletion_reclaim_allowed(true, false, true, true));
    }

    #[test]
    fn notification_reducer_contract_rechecks_permission_and_mute_state() {
        assert!(notification_preference_valid(
            Some(1_320),
            Some(420),
            540,
            "America/New_York",
        ));
        assert!(notification_coalesce_binding_valid(true, true, true, true));
        assert!(!notification_coalesce_binding_valid(
            true, true, false, true
        ));
        assert!(notification_delivery_allowed(true, true, false));
        assert!(!notification_delivery_allowed(false, true, false));
        assert!(!notification_delivery_allowed(true, true, true));
    }
}
