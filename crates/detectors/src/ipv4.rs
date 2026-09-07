use regex::Regex;
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct Ipv4Detector {
    id: DetectorId,
    kind: DetectionKind,
}

impl Ipv4Detector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.network.ipv4").unwrap(),
            kind: DetectionKind::new("ipv4_address").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // A bounded conservative candidate regex that isolates dot-separated octets.
        RE.get_or_init(|| Regex::new(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b").unwrap())
    }
}

impl Default for Ipv4Detector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for Ipv4Detector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().find_iter(text) {
            let candidate = mat.as_str();

            // Structural validation using the standard library.
            // A regex alone is not structural validation. This parser rejects things like 999.999.999.999.
            if Ipv4Addr::from_str(candidate).is_ok() {
                if let Ok(location) = DetectionLocation::new(mat.start(), mat.end()) {
                    if location.validate_for(text).is_ok() {
                        detections.push(Detection {
                            category: DetectionCategory::Pii,
                            kind: self.kind.clone(),
                            detector_id: self.id.clone(),
                            // Provisional deterministic confidence representing high certainty of an IP structure.
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
    fn test_ipv4_approved_fixtures_boundaries() {
        let detector = Ipv4Detector::new();
        // Approved fixtures: 192.0.2.53, 198.51.100.42, 203.0.113.10
        let test_cases = vec![
            (" 192.0.2.53 ", "192.0.2.53"),
            ("(198.51.100.42)", "198.51.100.42"),
            ("IP: 203.0.113.10.", "203.0.113.10"),
            ("server,192.0.2.53,end", "192.0.2.53"),
            ("[198.51.100.42]", "198.51.100.42"),
        ];

        for (input, expected) in test_cases {
            let text = SensitiveText::new(input.to_string());
            let detections = detector.inspect(&text);
            assert_eq!(detections.len(), 1, "Failed on input: {}", input);

            let detection = &detections[0];
            assert_eq!(detection.category, DetectionCategory::Pii);
            assert_eq!(detection.kind.as_str(), "ipv4_address");
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
