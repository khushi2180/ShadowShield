use shadowshield_protocol::{
    AiAccessAssessment, AiAccessDecision, AiAccessMode, AiAccessReason, AiServiceClassification,
    AiServiceId,
};

pub struct AiAccessPolicy {}

impl AiAccessPolicy {
    pub fn new() -> Self {
        Self {}
    }

    pub fn evaluate(
        &self,
        service_id: &AiServiceId,
        classification: &AiServiceClassification,
        mode: &AiAccessMode,
    ) -> AiAccessAssessment {
        let (decision, reason) = match mode {
            AiAccessMode::Discovery => match classification {
                AiServiceClassification::Approved => {
                    (AiAccessDecision::Allow, AiAccessReason::ApprovedService)
                }
                AiServiceClassification::Restricted => {
                    (AiAccessDecision::Allow, AiAccessReason::RestrictedService)
                }
                AiServiceClassification::Blocked => {
                    (AiAccessDecision::Allow, AiAccessReason::BlockedService)
                }
                AiServiceClassification::Unknown => {
                    (AiAccessDecision::Allow, AiAccessReason::UnknownService)
                }
            },
            AiAccessMode::Policy => match classification {
                AiServiceClassification::Approved => {
                    (AiAccessDecision::Allow, AiAccessReason::ApprovedService)
                }
                AiServiceClassification::Restricted => (
                    AiAccessDecision::AllowRestricted,
                    AiAccessReason::RestrictedService,
                ),
                AiServiceClassification::Blocked => {
                    (AiAccessDecision::Block, AiAccessReason::BlockedService)
                }
                AiServiceClassification::Unknown => {
                    (AiAccessDecision::Coach, AiAccessReason::UnknownService)
                }
            },
            AiAccessMode::StrictAllowlist => match classification {
                AiServiceClassification::Approved => {
                    (AiAccessDecision::Allow, AiAccessReason::ApprovedService)
                }
                AiServiceClassification::Restricted => {
                    (AiAccessDecision::Block, AiAccessReason::RestrictedService)
                }
                AiServiceClassification::Blocked => {
                    (AiAccessDecision::Block, AiAccessReason::BlockedService)
                }
                AiServiceClassification::Unknown => {
                    (AiAccessDecision::Block, AiAccessReason::UnknownService)
                }
            },
        };

        AiAccessAssessment {
            service_id: service_id.clone(),
            classification: classification.clone(),
            mode: mode.clone(),
            decision,
            reason,
        }
    }
}

impl Default for AiAccessPolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discovery_mode() {
        let policy = AiAccessPolicy::new();
        let id = AiServiceId::new("test").unwrap();

        let cases = vec![
            AiServiceClassification::Approved,
            AiServiceClassification::Restricted,
            AiServiceClassification::Blocked,
            AiServiceClassification::Unknown,
        ];

        for cls in cases {
            let assessment = policy.evaluate(&id, &cls, &AiAccessMode::Discovery);
            assert_eq!(assessment.decision, AiAccessDecision::Allow);
        }
    }

    #[test]
    fn test_policy_mode() {
        let policy = AiAccessPolicy::new();
        let id = AiServiceId::new("test").unwrap();

        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Approved,
                    &AiAccessMode::Policy
                )
                .decision,
            AiAccessDecision::Allow
        );
        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Restricted,
                    &AiAccessMode::Policy
                )
                .decision,
            AiAccessDecision::AllowRestricted
        );
        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Blocked,
                    &AiAccessMode::Policy
                )
                .decision,
            AiAccessDecision::Block
        );
        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Unknown,
                    &AiAccessMode::Policy
                )
                .decision,
            AiAccessDecision::Coach
        );
    }

    #[test]
    fn test_strict_allowlist_mode() {
        let policy = AiAccessPolicy::new();
        let id = AiServiceId::new("test").unwrap();

        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Approved,
                    &AiAccessMode::StrictAllowlist
                )
                .decision,
            AiAccessDecision::Allow
        );
        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Restricted,
                    &AiAccessMode::StrictAllowlist
                )
                .decision,
            AiAccessDecision::Block
        );
        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Blocked,
                    &AiAccessMode::StrictAllowlist
                )
                .decision,
            AiAccessDecision::Block
        );
        assert_eq!(
            policy
                .evaluate(
                    &id,
                    &AiServiceClassification::Unknown,
                    &AiAccessMode::StrictAllowlist
                )
                .decision,
            AiAccessDecision::Block
        );
    }
}
