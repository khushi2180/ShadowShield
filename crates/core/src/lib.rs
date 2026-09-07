use log::info;
use shadowshield_detectors::DetectorRegistry;
use shadowshield_protocol::{
    Detection, InspectionRequest, InspectionResult, PolicyAction, RiskAssessment, RiskLevel,
    Severity, ValidationLevel,
};
use std::time::Instant;

pub mod redaction;
use redaction::RedactionEngine;

#[derive(Debug, PartialEq, Eq)]
pub enum RiskError {
    EvaluationFailed,
}

pub struct RiskEngine {}

impl RiskEngine {
    pub fn new() -> Self {
        Self {}
    }

    fn severity_base(severity: &Severity) -> u8 {
        match severity {
            Severity::Low => 10,
            Severity::Medium => 30,
            Severity::High => 60,
            Severity::Critical => 90,
        }
    }

    fn validation_modifier(validation: &ValidationLevel) -> u8 {
        match validation {
            ValidationLevel::PatternMatch => 0,
            ValidationLevel::StructurallyValid => 5,
            ValidationLevel::ChecksumValid => 8,
            ValidationLevel::ContextCorrelated => 10,
        }
    }

    fn map_score_to_level(score: u8) -> RiskLevel {
        match score {
            0..=24 => RiskLevel::Low,
            25..=49 => RiskLevel::Medium,
            50..=79 => RiskLevel::High,
            _ => RiskLevel::Critical,
        }
    }

    pub fn evaluate(&self, detections: &[Detection]) -> Result<RiskAssessment, RiskError> {
        if detections.is_empty() {
            return Ok(RiskAssessment {
                score: 0,
                level: RiskLevel::Low,
                primary_detection_index: None,
            });
        }

        let mut max_score = 0;
        let mut primary_idx = 0;

        for (i, detection) in detections.iter().enumerate() {
            let base = Self::severity_base(&detection.severity);
            let modifier = Self::validation_modifier(&detection.validation);
            let score = std::cmp::min(100, base + modifier);

            if score > max_score {
                max_score = score;
                primary_idx = i;
            }
        }

        let level = Self::map_score_to_level(max_score);

        Ok(RiskAssessment {
            score: max_score,
            level,
            primary_detection_index: Some(primary_idx),
        })
    }
}

impl Default for RiskEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    EvaluationFailed,
}

pub struct PolicyEngine {}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {}
    }

    pub fn evaluate(&self, risk: &RiskLevel) -> Result<PolicyAction, PolicyError> {
        match risk {
            RiskLevel::Low => Ok(PolicyAction::Allow),
            RiskLevel::Medium => Ok(PolicyAction::Coach),
            RiskLevel::High => Ok(PolicyAction::Redact),
            RiskLevel::Critical => Ok(PolicyAction::Block),
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
    RedactionFailed,
}

pub struct Inspector {
    detectors: DetectorRegistry,
    risk_engine: RiskEngine,
    policy_engine: PolicyEngine,
    redaction_engine: RedactionEngine,
}

impl Inspector {
    pub fn new() -> Self {
        Self {
            detectors: DetectorRegistry::new(),
            risk_engine: RiskEngine::new(),
            policy_engine: PolicyEngine::new(),
            redaction_engine: RedactionEngine::new(),
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
        self.validate_request(&request)?;

        let start_time = Instant::now();
        info!("inspection started request_id={}", request.request_id);

        let detections = self.detectors.inspect_all(&request.content);

        let risk_assessment = self
            .risk_engine
            .evaluate(&detections)
            .map_err(|_| InspectorError::RiskEvaluationFailed)?;

        let action = self
            .policy_engine
            .evaluate(&risk_assessment.level)
            .map_err(|_| InspectorError::PolicyEvaluationFailed)?;

        let mut sanitized_content = None;
        if action == PolicyAction::Redact {
            let redacted = self
                .redaction_engine
                .redact(&request.content, &detections)
                .map_err(|_| InspectorError::RedactionFailed)?;
            sanitized_content = Some(redacted);
        }

        let processing_duration_ms = start_time.elapsed().as_millis() as u64;

        info!(
            "inspection completed request_id={} detections={} risk={:?} score={} action={:?} duration_ms={}",
            request.request_id,
            detections.len(),
            risk_assessment.level,
            risk_assessment.score,
            action,
            processing_duration_ms
        );

        Ok(InspectionResult {
            request_id: request.request_id,
            detections,
            risk_assessment,
            action,
            sanitized_content,
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
        assert_eq!(result.risk_assessment.level, RiskLevel::Low);
        assert_eq!(result.risk_assessment.score, 0);
        assert_eq!(result.action, PolicyAction::Allow);
        assert!(result.sanitized_content.is_none());
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
    fn test_risk_scoring_combinations() {
        let risk_engine = RiskEngine::new();

        let make_det = |sev, val| Detection {
            category: DetectionCategory::TestStructural,
            kind: shadowshield_protocol::DetectionKind::new("test").unwrap(),
            detector_id: shadowshield_protocol::DetectorId::new("test.det").unwrap(),
            confidence: Confidence::new(100).unwrap(),
            validation: val,
            location: None,
            severity: sev,
        };

        // Low + PatternMatch -> 10
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(Severity::Low, ValidationLevel::PatternMatch)])
                .unwrap()
                .score,
            10
        );
        // Medium + PatternMatch -> 30
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(Severity::Medium, ValidationLevel::PatternMatch)])
                .unwrap()
                .score,
            30
        );
        // Medium + StructurallyValid -> 35
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(
                    Severity::Medium,
                    ValidationLevel::StructurallyValid
                )])
                .unwrap()
                .score,
            35
        );
        // High + PatternMatch -> 60
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(Severity::High, ValidationLevel::PatternMatch)])
                .unwrap()
                .score,
            60
        );
        // High + StructurallyValid -> 65
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(Severity::High, ValidationLevel::StructurallyValid)])
                .unwrap()
                .score,
            65
        );
        // High + ChecksumValid -> 68
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(Severity::High, ValidationLevel::ChecksumValid)])
                .unwrap()
                .score,
            68
        );
        // Critical + PatternMatch -> 90
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(Severity::Critical, ValidationLevel::PatternMatch)])
                .unwrap()
                .score,
            90
        );
        // Critical + StructurallyValid -> 95
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(
                    Severity::Critical,
                    ValidationLevel::StructurallyValid
                )])
                .unwrap()
                .score,
            95
        );
        // Critical + ContextCorrelated -> 100
        assert_eq!(
            risk_engine
                .evaluate(&[make_det(
                    Severity::Critical,
                    ValidationLevel::ContextCorrelated
                )])
                .unwrap()
                .score,
            100
        );
    }

    #[test]
    fn test_risk_thresholds() {
        assert_eq!(RiskEngine::map_score_to_level(0), RiskLevel::Low);
        assert_eq!(RiskEngine::map_score_to_level(24), RiskLevel::Low);
        assert_eq!(RiskEngine::map_score_to_level(25), RiskLevel::Medium);
        assert_eq!(RiskEngine::map_score_to_level(49), RiskLevel::Medium);
        assert_eq!(RiskEngine::map_score_to_level(50), RiskLevel::High);
        assert_eq!(RiskEngine::map_score_to_level(79), RiskLevel::High);
        assert_eq!(RiskEngine::map_score_to_level(80), RiskLevel::Critical);
        assert_eq!(RiskEngine::map_score_to_level(100), RiskLevel::Critical);
    }

    #[test]
    fn test_multiple_detections_aggregate_max() {
        let risk_engine = RiskEngine::new();

        let make_det = |sev, val| Detection {
            category: DetectionCategory::TestStructural,
            kind: shadowshield_protocol::DetectionKind::new("test").unwrap(),
            detector_id: shadowshield_protocol::DetectorId::new("test.det").unwrap(),
            confidence: Confidence::new(100).unwrap(),
            validation: val,
            location: None,
            severity: sev,
        };

        // three Medium PatternMatch detections -> 30, Medium
        let dets = vec![
            make_det(Severity::Medium, ValidationLevel::PatternMatch),
            make_det(Severity::Medium, ValidationLevel::PatternMatch),
            make_det(Severity::Medium, ValidationLevel::PatternMatch),
        ];
        let assessment = risk_engine.evaluate(&dets).unwrap();
        assert_eq!(assessment.score, 30);
        assert_eq!(assessment.level, RiskLevel::Medium);

        // Medium + Critical -> Critical score
        let dets2 = vec![
            make_det(Severity::Medium, ValidationLevel::PatternMatch),
            make_det(Severity::Critical, ValidationLevel::PatternMatch),
        ];
        let assessment2 = risk_engine.evaluate(&dets2).unwrap();
        assert_eq!(assessment2.score, 90);
        assert_eq!(assessment2.level, RiskLevel::Critical);
    }

    #[test]
    fn test_policy_engine_mapping() {
        let policy_engine = PolicyEngine::new();

        assert_eq!(
            policy_engine.evaluate(&RiskLevel::Low),
            Ok(PolicyAction::Allow)
        );
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::Medium),
            Ok(PolicyAction::Coach)
        );
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::High),
            Ok(PolicyAction::Redact)
        );
        assert_eq!(
            policy_engine.evaluate(&RiskLevel::Critical),
            Ok(PolicyAction::Block)
        );
    }
}
