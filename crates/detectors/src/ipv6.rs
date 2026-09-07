use regex::Regex;
use std::net::Ipv6Addr;
use std::str::FromStr;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct Ipv6Detector {
    id: DetectorId,
    kind: DetectionKind,
}

impl Ipv6Detector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.network.ipv6").unwrap(),
            kind: DetectionKind::new("ipv6_address").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // A broad candidate extractor that looks for at least 2 colons separating hex blocks.
        // It captures compressed forms like ::1 and 2001:db8::1.
        // The regex itself doesn't validate IPv6 - it just bounds the candidate properly without
        // consuming surrounding punctuation for the parser.
        RE.get_or_init(|| Regex::new(r"(?i)(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}").unwrap())
    }
}

impl Default for Ipv6Detector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for Ipv6Detector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().find_iter(text) {
            let candidate = mat.as_str();

            // Structural validation using the standard library.
            // This firmly rejects MAC addresses and malformed hex strings.
            if Ipv6Addr::from_str(candidate).is_ok() {
                if let Ok(location) = DetectionLocation::new(mat.start(), mat.end()) {
                    if location.validate_for(text).is_ok() {
                        detections.push(Detection {
                            category: DetectionCategory::Pii,
                            kind: self.kind.clone(),
                            detector_id: self.id.clone(),
                            // Provisional deterministic confidence
                            confidence: Confidence::new(90).unwrap(),
                            validation: ValidationLevel::StructurallyValid,
                            location: Some(location),
                            severity: Severity::Medium,
                        });
                    }
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
    fn test_ipv6_approved_fixtures_boundaries() {
        let detector = Ipv6Detector::new();
        // Approved fixtures: 2001:db8::1, 2001:db8:582:ae33::29
        let test_cases = vec![
            (" 2001:db8::1 ", "2001:db8::1"),
            ("(2001:db8::1)", "2001:db8::1"),
            ("[2001:db8:582:ae33::29]", "2001:db8:582:ae33::29"),
            ("Address: 2001:db8::1, ok", "2001:db8::1"),
        ];

        for (input, expected) in test_cases {
            let text = SensitiveText::new(input.to_string());
            let detections = detector.inspect(&text);
            assert_eq!(detections.len(), 1, "Failed on input: {}", input);

            let detection = &detections[0];
            assert_eq!(detection.category, DetectionCategory::Pii);
            assert_eq!(detection.kind.as_str(), "ipv6_address");
            assert_eq!(detection.validation, ValidationLevel::StructurallyValid);
            assert_eq!(detection.severity, Severity::Medium);
            assert_eq!(detection.confidence.value(), 90);

            let loc = detection.location.unwrap();
            assert!(loc.validate_for(text.expose()).is_ok());

            // Verify exactly the approved fixture is extracted
            let extracted = &text.expose()[loc.start_byte()..loc.end_byte()];
            assert_eq!(extracted, expected);
        }
    }
}
