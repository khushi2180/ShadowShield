use serde::{Deserialize, Serialize};
use std::fmt;

pub mod ipc;
/// A wrapper for sensitive text ensuring it doesn't accidentally leak in Debug logs.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensitiveText(String);

impl SensitiveText {
    pub fn new(content: String) -> Self {
        Self(content)
    }

    /// Deliberate access to the underlying sensitive string.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SensitiveText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SensitiveText(<redacted>)")
    }
}

/// Sanitized text that has been redacted by the policy engine.
/// Still treated carefully to avoid leaking undetected secrets.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SanitizedText(String);

impl SanitizedText {
    pub fn new(content: String) -> Self {
        Self(content)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SanitizedText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SanitizedText(<sanitized>)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InspectionSource {
    BrowserExtension,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectionRequest {
    pub request_id: String,
    pub source: InspectionSource,
    pub ai_service: String,
    pub content: SensitiveText,
    pub timestamp: u64,
}

/// Confidence representation restricted to 0-100 percentage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Confidence(u8);

impl Confidence {
    pub fn new(value: u8) -> Result<Self, &'static str> {
        if value <= 100 {
            Ok(Self(value))
        } else {
            Err("Confidence must be between 0 and 100")
        }
    }

    pub fn value(&self) -> u8 {
        self.0
    }
}

/// Location representation using byte offsets to be safe for Unicode and Rust slice operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectionLocation {
    start_byte: usize,
    end_byte: usize,
}

impl DetectionLocation {
    pub fn new(start: usize, end: usize) -> Result<Self, &'static str> {
        if start <= end {
            Ok(Self {
                start_byte: start,
                end_byte: end,
            })
        } else {
            Err("start_byte must be <= end_byte")
        }
    }

    pub fn start_byte(&self) -> usize {
        self.start_byte
    }

    pub fn end_byte(&self) -> usize {
        self.end_byte
    }

    /// Validates that the byte offsets represent valid character boundaries in the given text.
    pub fn validate_for(&self, content: &str) -> Result<(), &'static str> {
        if self.start_byte > self.end_byte {
            return Err("start_byte is greater than end_byte");
        }
        if self.end_byte > content.len() {
            return Err("end_byte exceeds content length");
        }
        if !content.is_char_boundary(self.start_byte) {
            return Err("start_byte is not a valid UTF-8 character boundary");
        }
        if !content.is_char_boundary(self.end_byte) {
            return Err("end_byte is not a valid UTF-8 character boundary");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectionKind(String);

impl DetectionKind {
    pub fn new(kind: &str) -> Result<Self, &'static str> {
        if kind.is_empty() {
            return Err("empty kind");
        }
        let mut chars = kind.chars();
        let first = chars.next().unwrap();
        if !first.is_ascii_lowercase() {
            return Err("must start with lowercase letter");
        }
        let mut prev_was_sep = false;
        for c in chars {
            if c == '_' {
                if prev_was_sep {
                    return Err("repeated separator");
                }
                prev_was_sep = true;
            } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
                prev_was_sep = false;
            } else {
                return Err("invalid character");
            }
        }
        if prev_was_sep {
            return Err("trailing separator");
        }

        Ok(Self(kind.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DetectionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorId(String);

impl DetectorId {
    pub fn new(id: &str) -> Result<Self, &'static str> {
        if id.is_empty() {
            return Err("empty id");
        }
        let mut chars = id.chars();
        let first = chars.next().unwrap();
        if !first.is_ascii_lowercase() {
            return Err("must start with lowercase letter");
        }
        let mut prev_was_sep = false;
        for c in chars {
            if c == '.' || c == '_' {
                if prev_was_sep {
                    return Err("repeated separator");
                }
                prev_was_sep = true;
            } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
                prev_was_sep = false;
            } else {
                return Err("invalid character");
            }
        }
        if prev_was_sep {
            return Err("trailing separator");
        }
        Ok(Self(id.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DetectorId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum ValidationLevel {
    PatternMatch,
    StructurallyValid,
    ChecksumValid,
    ContextCorrelated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub category: DetectionCategory,
    pub kind: DetectionKind,
    pub detector_id: DetectorId,
    pub confidence: Confidence,
    pub validation: ValidationLevel,
    pub location: Option<DetectionLocation>,
    pub severity: Severity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DetectionCategory {
    Secret,
    Credential,
    Pii,
    SourceCode,
    TestStructural, // Added purely for structural testing without using security fixtures
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyAction {
    Allow,
    Coach,
    Redact,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyActionReason {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskAssessment {
    pub score: u8,
    pub level: RiskLevel,
    pub primary_detection_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectionResult {
    pub request_id: String,
    pub detections: Vec<Detection>,
    pub risk_assessment: RiskAssessment,
    pub action: PolicyAction,
    /// Only present if action == Redact
    pub sanitized_content: Option<SanitizedText>,
    /// Minimal processing metadata: time taken for inspection in milliseconds.
    pub processing_duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_confidence_validation() {
        assert!(Confidence::new(0).is_ok());
        assert!(Confidence::new(100).is_ok());
        assert!(Confidence::new(101).is_err());
    }

    #[test]
    fn test_detection_location_validation_bounds() {
        assert!(DetectionLocation::new(0, 10).is_ok());
        assert!(DetectionLocation::new(10, 5).is_err());
    }

    #[test]
    fn test_detection_location_unicode() {
        let text = "Hello, 世界"; // '世' is 3 bytes (idx 7..10), '界' is 3 bytes (idx 10..13)
        assert_eq!(text.len(), 13);

        // ASCII boundaries
        let loc1 = DetectionLocation::new(0, 5).unwrap();
        assert!(loc1.validate_for(text).is_ok());

        // Valid UTF-8 multibyte boundary
        let loc2 = DetectionLocation::new(7, 10).unwrap();
        assert!(loc2.validate_for(text).is_ok());

        // Invalid mid-code-point boundary (split '世')
        let loc3 = DetectionLocation::new(7, 8).unwrap();
        assert!(loc3.validate_for(text).is_err());

        // Out of range boundary
        let loc4 = DetectionLocation::new(0, 15).unwrap();
        assert!(loc4.validate_for(text).is_err());
    }

    #[test]
    fn test_detection_kind_validation() {
        assert!(DetectionKind::new("aws_access_key").is_ok());
        assert!(DetectionKind::new("aws_access_key_123").is_ok());

        // Invalid
        assert!(DetectionKind::new("").is_err()); // empty
        assert!(DetectionKind::new("AWS_KEY").is_err()); // uppercase
        assert!(DetectionKind::new("aws key").is_err()); // whitespace
        assert!(DetectionKind::new("aws-key").is_err()); // hyphens
        assert!(DetectionKind::new("_aws").is_err()); // leading underscore
        assert!(DetectionKind::new("aws_").is_err()); // trailing underscore
        assert!(DetectionKind::new("aws__key").is_err()); // repeated underscore
    }

    #[test]
    fn test_detector_id_validation() {
        assert!(DetectorId::new("secret.aws.access_key").is_ok());
        assert!(DetectorId::new("pii.payment_card").is_ok());

        // Invalid
        assert!(DetectorId::new("Secret").is_err()); // uppercase
        assert!(DetectorId::new("secret..aws").is_err()); // repeated separator
        assert!(DetectorId::new("secret.aws.").is_err()); // trailing separator
    }

    #[test]
    fn test_sensitive_text_debug_output() {
        let sensitive = SensitiveText::new("my super secret password".to_string());
        let debug_str = format!("{:?}", sensitive);
        assert!(!debug_str.contains("password"));
        assert_eq!(debug_str, "SensitiveText(<redacted>)");

        let request = InspectionRequest {
            request_id: "r1".to_string(),
            source: InspectionSource::Unknown,
            ai_service: "chatgpt".to_string(),
            content: sensitive,
            timestamp: 0,
        };
        let req_debug = format!("{:?}", request);
        assert!(!req_debug.contains("password"));
        assert!(req_debug.contains("SensitiveText(<redacted>)"));
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AiServiceId(String);

impl AiServiceId {
    pub fn new(id: &str) -> Result<Self, &'static str> {
        if id.is_empty() {
            return Err("empty id");
        }
        let mut chars = id.chars();
        let first = chars.next().unwrap();
        if !first.is_ascii_lowercase() {
            return Err("must start with lowercase letter");
        }
        let mut prev_was_sep = false;
        for c in chars {
            if c == '_' {
                if prev_was_sep {
                    return Err("repeated separator");
                }
                prev_was_sep = true;
            } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
                prev_was_sep = false;
            } else {
                return Err("invalid character");
            }
        }
        if prev_was_sep {
            return Err("trailing separator");
        }

        Ok(Self(id.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AiServiceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiServiceClassification {
    Approved,
    Restricted,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiAccessMode {
    Discovery,
    Policy,
    StrictAllowlist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiAccessDecision {
    Allow,
    AllowRestricted,
    Coach,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiAccessReason {
    ApprovedService,
    RestrictedService,
    BlockedService,
    UnknownService,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiService {
    pub id: AiServiceId,
    pub display_name: String,
    pub vendor: String,
    pub classification: AiServiceClassification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiAccessAssessment {
    pub service_id: AiServiceId,
    pub classification: AiServiceClassification,
    pub mode: AiAccessMode,
    pub decision: AiAccessDecision,
    pub reason: AiAccessReason,
}

#[cfg(test)]
mod ai_governance_tests {
    use super::*;

    #[test]
    fn test_ai_service_id_validation() {
        assert!(AiServiceId::new("chatgpt").is_ok());
        assert!(AiServiceId::new("gemini_1_5").is_ok());

        assert!(AiServiceId::new("").is_err());
        assert!(AiServiceId::new("ChatGPT").is_err());
        assert!(AiServiceId::new("claude-3").is_err());
        assert!(AiServiceId::new("_gemini").is_err());
        assert!(AiServiceId::new("gemini_").is_err());
        assert!(AiServiceId::new("chat__gpt").is_err());
    }
}
