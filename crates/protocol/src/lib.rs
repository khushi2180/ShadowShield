use std::fmt;

/// A wrapper for sensitive text ensuring it doesn't accidentally leak in Debug logs.
#[derive(Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InspectionSource {
    BrowserExtension,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectionRequest {
    pub request_id: String,
    pub source: InspectionSource,
    pub ai_service: String,
    pub content: SensitiveText,
    pub timestamp: u64,
}

/// Confidence representation restricted to 0-100 percentage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectionLocation {
    pub start_byte: usize,
    pub end_byte: usize,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    pub category: DetectionCategory,
    pub kind: String, // e.g. "aws_access_key"
    pub detector_id: String,
    pub confidence: Confidence,
    pub location: Option<DetectionLocation>,
    pub severity: Severity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectionCategory {
    Secret,
    Credential,
    Pii,
    SourceCode,
    TestStructural, // Added purely for structural testing without using security fixtures
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyAction {
    Allow,
    Coach,
    Redact,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectionResult {
    pub request_id: String,
    pub detections: Vec<Detection>,
    pub risk: RiskLevel,
    pub action: PolicyAction,
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

        // Reversed range (though blocked by new(), we can test it conceptually or bypass for test)
        let loc5 = DetectionLocation {
            start_byte: 10,
            end_byte: 5,
        };
        assert!(loc5.validate_for(text).is_err());
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
