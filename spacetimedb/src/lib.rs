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
        direct_message_replay_gate, direct_message_target_gate,
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
}
