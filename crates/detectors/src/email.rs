use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct EmailDetector {
    id: DetectorId,
    kind: DetectionKind,
}

impl EmailDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.contact.email").unwrap(),
            kind: DetectionKind::new("email_address").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // A conservative practical email regex. Not fully RFC 5322 compliant,
        // but designed to find common employee emails without excessive false positives.
        RE.get_or_init(|| Regex::new(r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}\b").unwrap())
    }
}

impl Default for EmailDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for EmailDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().find_iter(text) {
            let candidate = mat.as_str();

            // The regex enforces length constraints and structure.
            // We just ensure overall length is within RFC practical maximums (254).
            if candidate.len() > 254 {
                continue;
            }

            if let Ok(location) = DetectionLocation::new(mat.start(), mat.end()) {
                if location.validate_for(text).is_ok() {
                    detections.push(Detection {
                        category: DetectionCategory::Pii,
                        kind: self.kind.clone(),
                        detector_id: self.id.clone(),
                        confidence: Confidence::new(85).unwrap(),
                        // Because we rely purely on a regular expression without a rigorous structural parse into a Rust domain object, we honestly classify this as PatternMatch.
                        validation: ValidationLevel::PatternMatch,
                        location: Some(location),
                        severity: Severity::Medium,
                    });
                }
            }
        }
        detections
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_email_approved_fixtures_boundaries() {
        let detector = EmailDetector::new();
        // Approved fixtures: alice@example.com, security@example.org
        let test_cases = vec![
            (" alice@example.com ", "alice@example.com"),
            ("(security@example.org)", "security@example.org"),
            ("Email,alice@example.com,test", "alice@example.com"),
            ("Send to security@example.org.", "security@example.org"),
        ];

        for (input, expected) in test_cases {
            let text = SensitiveText::new(input.to_string());
            let detections = detector.inspect(&text);
            assert_eq!(detections.len(), 1, "Failed on input: {}", input);

            let detection = &detections[0];
            assert_eq!(detection.category, DetectionCategory::Pii);
            assert_eq!(detection.kind.as_str(), "email_address");
            assert_eq!(detection.validation, ValidationLevel::PatternMatch);
            assert_eq!(detection.severity, Severity::Medium);
            assert_eq!(detection.confidence.value(), 85);

            let loc = detection.location.unwrap();
            assert!(loc.validate_for(text.expose()).is_ok());

            // Verify exactly the approved fixture is extracted
            let extracted = &text.expose()[loc.start_byte()..loc.end_byte()];
            assert_eq!(extracted, expected);
        }
    }
}
