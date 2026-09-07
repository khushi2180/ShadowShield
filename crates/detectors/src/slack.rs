use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct SlackDetector {
    id: DetectorId,
}

impl SlackDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("secret.slack.token").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Slack prefixes: xoxb-, xoxp-, xapp-
        // Bound by `(?:^|[^A-Za-z0-9_])`
        // Given historical variations in user token lengths, we permit a broad, conservative length.
        RE.get_or_init(|| {
            Regex::new(
                r"(?:^|[^A-Za-z0-9_])((?:xoxb|xoxp|xapp)-[A-Za-z0-9\-]{10,255})(?:$|[^A-Za-z0-9_])",
            )
            .unwrap()
        })
    }

    fn determine_kind(prefix: &str) -> DetectionKind {
        let kind_str = match prefix {
            "xoxb" => "slack_bot_token",
            "xoxp" => "slack_user_token",
            "xapp" => "slack_app_token",
            _ => "slack_token",
        };
        DetectionKind::new(kind_str).unwrap()
    }
}

impl Default for SlackDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for SlackDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let candidate_match = mat.get(1).unwrap();
            let candidate = candidate_match.as_str();

            let prefix = &candidate[0..4]; // First 4 chars identify kind before hyphen
            let precise_kind = Self::determine_kind(prefix);

            if candidate.len() > 65536 {
                continue;
            }

            if let Ok(location) =
                DetectionLocation::new(candidate_match.start(), candidate_match.end())
            {
                if location.validate_for(text).is_ok() {
                    detections.push(Detection {
                        category: DetectionCategory::Secret,
                        kind: precise_kind,
                        detector_id: self.id.clone(),
                        confidence: Confidence::new(97).unwrap(),
                        validation: ValidationLevel::PatternMatch,
                        location: Some(location),
                        severity: Severity::Critical,
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
    fn test_slack_prefix_mapping_without_secrets() {
        let detector = SlackDetector::new();
        // Positive credential detection is BLOCKED_BY_FIXTURE.
        // Testing that the regex correctly performs structural prefix mapping on placeholder values.
        let test_cases = vec![
            ("xoxb-1234567890", "slack_bot_token"),
            ("xoxp-1234567890", "slack_user_token"),
            ("xapp-1234567890", "slack_app_token"),
        ];

        for (input, expected_kind) in test_cases {
            let text = SensitiveText::new(format!("token={}", input));
            let detections = detector.inspect(&text);
            assert_eq!(
                detections.len(),
                1,
                "Failed structural parse on prefix: {}",
                input
            );
            assert_eq!(detections[0].kind.as_str(), expected_kind);
        }
    }
}
