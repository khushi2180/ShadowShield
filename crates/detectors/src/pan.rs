use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId, SensitiveText,
    Severity, ValidationLevel,
};

use crate::Detector;

pub struct PanDetector {
    id: DetectorId,
}

impl PanDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.india.pan").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Indian PAN format: 5 letters, 4 digits, 1 letter.
        // We use explicit structural boundaries.
        RE.get_or_init(|| Regex::new(
            r"(?:^|[^A-Z0-9])([A-Z]{5}[0-9]{4}[A-Z])(?:$|[^A-Z0-9])"
        ).unwrap())
    }

    /// Perform official structural constraints where locally possible.
    /// The 4th character represents the status (P, C, H, F, A, T, B, L, J, G).
    fn is_structurally_valid(pan: &str) -> bool {
        if pan.len() != 10 {
            return false;
        }
        let fourth_char = pan.chars().nth(3).unwrap();
        matches!(fourth_char, 'P' | 'C' | 'H' | 'F' | 'A' | 'T' | 'B' | 'L' | 'J' | 'G')
    }
}

impl Default for PanDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for PanDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let candidate_match = mat.get(1).unwrap();
            let candidate = candidate_match.as_str();

            if Self::is_structurally_valid(candidate) {
                if let Ok(location) = DetectionLocation::new(candidate_match.start(), candidate_match.end()) {
                    if location.validate_for(text).is_ok() {
                        detections.push(Detection {
                            category: DetectionCategory::Pii,
                            kind: DetectionKind::new("indian_pan").unwrap(),
                            detector_id: self.id.clone(),
                            confidence: Confidence::new(90).unwrap(), 
                            validation: ValidationLevel::StructurallyValid,
                            location: Some(location),
                            severity: Severity::High,
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
    fn test_pan_structural_validation_logic() {
        // Positive credential testing is BLOCKED_BY_FIXTURE.
        // We solely test the internal structural helper logic.
        assert!(PanDetector::is_structurally_valid("ABCDE1234F") == false); // E is not a valid 4th char
        assert!(PanDetector::is_structurally_valid("ABCPD1234F") == true);  // P is valid
        assert!(PanDetector::is_structurally_valid("ABCCH1234F") == true);  // C is valid
    }
}
