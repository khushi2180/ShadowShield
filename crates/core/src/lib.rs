use log::info;
use shadowshield_detectors::DetectorRegistry;
use shadowshield_protocol::{
    Detection, InspectionRequest, InspectionResult, PolicyAction, RiskLevel,
};
use std::time::Instant;

#[derive(Debug, PartialEq, Eq)]
pub enum RiskError {
    EvaluationNotImplemented,
}

pub struct RiskEngine {}

impl RiskEngine {
    pub fn new() -> Self {
        Self {}
    }

    /// Determine baseline risk. For Phase 1A, this returns LOW for 0 detections, error otherwise.
    pub fn evaluate(&self, detections: &[Detection]) -> Result<RiskLevel, RiskError> {
        if detections.is_empty() {
            Ok(RiskLevel::Low)
        } else {
            Err(RiskError::EvaluationNotImplemented)
        }
    }
}

impl Default for RiskEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    EvaluationNotImplemented,
}

pub struct PolicyEngine {}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {}
    }

    /// Determine baseline policy action. For Phase 1A, LOW risk returns ALLOW, error otherwise.
    pub fn evaluate(&self, risk: &RiskLevel) -> Result<PolicyAction, PolicyError> {
        match risk {
            RiskLevel::Low => Ok(PolicyAction::Allow),
            _ => Err(PolicyError::EvaluationNotImplemented),
        }
    }
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InspectorError {
    InvalidRequest(String),
    RiskEvaluationFailed,
    PolicyEvaluationFailed,
}

pub struct Inspector {
    detectors: DetectorRegistry,
    risk_engine: RiskEngine,
    policy_engine: PolicyEngine,
}

impl Inspector {
    pub fn new() -> Self {
        Self {
            detectors: DetectorRegistry::new(),
            risk_engine: RiskEngine::new(),
            policy_engine: PolicyEngine::new(),
        }
    }

    pub fn validate_request(&self, request: &InspectionRequest) -> Result<(), InspectorError> {
        if request.request_id.trim().is_empty() {
            return Err(InspectorError::InvalidRequest(
                "request_id cannot be empty".to_string(),
            ));
        }
        if request.ai_service.trim().is_empty() {
            return Err(InspectorError::InvalidRequest(
                "ai_service cannot be empty".to_string(),
            ));
        }
        Ok(())
    }

    pub fn inspect(&self, request: InspectionRequest) -> Result<InspectionResult, InspectorError> {
        // Validate request structurally before starting inspection
        self.validate_request(&request)?;

        let start_time = Instant::now();
        info!("inspection started request_id={}", request.request_id);

        // Run registered detectors
        let detections = self.detectors.inspect_all(&request.content);

        // Determine baseline risk
        let risk = self
            .risk_engine
            .evaluate(&detections)
            .map_err(|_| InspectorError::RiskEvaluationFailed)?;

        // Determine baseline policy action
        let action = self
            .policy_engine
            .evaluate(&risk)
            .map_err(|_| InspectorError::PolicyEvaluationFailed)?;

        let processing_duration_ms = start_time.elapsed().as_millis() as u64;

        // NOTE: We do not log content here. We only log privacy-safe metadata.
        info!(
            "inspection completed request_id={} detections={} risk={:?} action={:?} duration_ms={}",
            request.request_id,
            detections.len(),
            risk,
            action,
            processing_duration_ms
        );

        Ok(InspectionResult {
            request_id: request.request_id,
            detections,
            risk,
            action,
            processing_duration_ms,
        })
    }
}

impl Default for Inspector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shadowshield_protocol::{
        Confidence, DetectionCategory, InspectionSource, SensitiveText, Severity,
    };

    #[test]
    fn test_empty_inspection_produces_low_allow() {
        let inspector = Inspector::new();
        let request = InspectionRequest {
            request_id: "test-123".to_string(),
            source: InspectionSource::Unknown,
            ai_service: "chatgpt".to_string(),
            content: SensitiveText::new("just some neutral text".to_string()),
            timestamp: 0,
        };

        let result = inspector.inspect(request).expect("Inspection failed");
        assert_eq!(result.detections.len(), 0);
        assert_eq!(result.risk, RiskLevel::Low);
        assert_eq!(result.action, PolicyAction::Allow);
    }

    #[test]
    fn test_invalid_request_validation() {
        let inspector = Inspector::new();
        let request = InspectionRequest {
            request_id: "".to_string(), // Invalid empty
            source: InspectionSource::Unknown,
            ai_service: "chatgpt".to_string(),
            content: SensitiveText::new("text".to_string()),
            timestamp: 0,
        };
        let err = inspector.inspect(request).unwrap_err();
        assert!(matches!(err, InspectorError::InvalidRequest(_)));
    }

    #[test]
    fn test_risk_engine_fail_open_prevention() {
        let risk_engine = RiskEngine::new();

        // 0 detections -> LOW
        assert_eq!(risk_engine.evaluate(&[]), Ok(RiskLevel::Low));

        // Non-zero detections -> Err
        let dummy_detection = Detection {
            category: DetectionCategory::TestStructural,
            kind: "structural_test".to_string(),
            detector_id: "test_detector".to_string(),
            confidence: Confidence::new(100).unwrap(),
            location: None,
            severity: Severity::Low,
        };

        assert_eq!(
            risk_engine.evaluate(&[dummy_detection]),
            Err(RiskError::EvaluationNotImplemented)
        );
    }

    #[test]
    fn test_policy_engine_fail_open_prevention() {
        let policy_engine = PolicyEngine::new();

        // Low -> Allow
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::Low),
            Ok(PolicyAction::Allow)
        );

        // Others -> Err
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::Medium),
            Err(PolicyError::EvaluationNotImplemented)
        );
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::High),
            Err(PolicyError::EvaluationNotImplemented)
        );
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::Critical),
            Err(PolicyError::EvaluationNotImplemented)
        );
    }
}
