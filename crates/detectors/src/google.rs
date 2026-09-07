use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct GoogleDetector {
    id: DetectorId,
}

impl GoogleDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("secret.google.api_key").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Google API keys are characterized by AIza followed by 35 alphanumeric/underscore/hyphen characters.
        RE.get_or_init(|| {
            Regex::new(r"(?:^|[^A-Za-z0-9_])(AIza[A-Za-z0-9_\-]{35})(?:$|[^A-Za-z0-9_])").unwrap()
        })
    }
}

impl Default for GoogleDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for GoogleDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let candidate_match = mat.get(1).unwrap();
            let candidate = candidate_match.as_str();

            if candidate.len() > 65536 {
                continue; // engineering limit
            }

            if let Ok(location) =
                DetectionLocation::new(candidate_match.start(), candidate_match.end())
            {
                if location.validate_for(text).is_ok() {
                    detections.push(Detection {
                        category: DetectionCategory::Secret,
                        kind: DetectionKind::new("google_api_key").unwrap(),
                        detector_id: self.id.clone(),
                        confidence: Confidence::new(97).unwrap(),
                        validation: ValidationLevel::PatternMatch,
                        location: Some(location),
                        severity: Severity::High, // Assuming High, as a naked API key's exploitability depends on domain restrictions.
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
    fn test_google_prefix_mapping_without_secrets() {
        let detector = GoogleDetector::new();
        // Positive credential detection is BLOCKED_BY_FIXTURE.
        // We only verify the prefix and structural length requirements using a placeholder matching the regex.
        let input = "AIza12345678901234567890123456789012345"; // 4 + 35 = 39 characters
        let text = SensitiveText::new(format!("key={}", input));
        let detections = detector.inspect(&text);
        assert_eq!(
            detections.len(),
            1,
            "Failed structural parse on prefix: {}",
            input
        );
        assert_eq!(detections[0].kind.as_str(), "google_api_key");
    }
}
