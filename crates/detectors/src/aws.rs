use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct AwsDetector {
    id: DetectorId,
}

impl AwsDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("secret.aws.credentials").unwrap(),
        }
    }

    fn akia_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?:^|[^A-Za-z0-9_])(AKIA[A-Z0-9]{16})(?:$|[^A-Za-z0-9_])").unwrap()
        })
    }

    // A loose check for base64-like 40-character strings used as the secret candidate
    fn secret_regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::new(r"(?:^|[^A-Za-z0-9\+/=])([A-Za-z0-9\+/=]{40})(?:$|[^A-Za-z0-9\+/=])")
                .unwrap()
        })
    }

    // Allowed contextual hints
    fn context_keywords() -> &'static [&'static str] {
        &[
            "AWS_ACCESS_KEY_ID",
            "aws_access_key_id",
            "AWS_SECRET_ACCESS_KEY",
            "aws_secret_access_key",
        ]
    }
}

impl Default for AwsDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for AwsDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        // 1. Detect standalone long-term access keys
        let mut access_key_locations = Vec::new();
        for mat in Self::akia_regex().captures_iter(text) {
            let candidate_match = mat.get(1).unwrap();
            let start = candidate_match.start();
            let end = candidate_match.end();
            if let Ok(location) = DetectionLocation::new(start, end) {
                if location.validate_for(text).is_ok() {
                    access_key_locations.push(location);
                    detections.push(Detection {
                        category: DetectionCategory::Credential,
                        kind: DetectionKind::new("aws_access_key_id").unwrap(),
                        detector_id: self.id.clone(),
                        confidence: Confidence::new(99).unwrap(),
                        validation: ValidationLevel::PatternMatch,
                        location: Some(location),
                        severity: Severity::High,
                    });
                }
            }
        }

        // 2. Strong correlation: Check for ContextCorrelated AWS pair
        // Must find access key + secret candidate + context keywords in reasonable proximity (e.g. same text block)
        if !access_key_locations.is_empty() {
            let mut has_keyword = false;
            for kw in Self::context_keywords() {
                if text.contains(kw) {
                    has_keyword = true;
                    break;
                }
            }

            if has_keyword {
                for mat in Self::secret_regex().captures_iter(text) {
                    let secret_match = mat.get(1).unwrap();
                    let secret = secret_match.as_str();
                    // We must ignore AKIA values overlapping as secrets
                    if secret.starts_with("AKIA") {
                        continue;
                    }
                    if let Ok(location) =
                        DetectionLocation::new(secret_match.start(), secret_match.end())
                    {
                        if location.validate_for(text).is_ok() {
                            // If we have access key + secret + context keyword -> Critical Pair
                            detections.push(Detection {
                                category: DetectionCategory::Credential,
                                kind: DetectionKind::new("aws_credential_pair").unwrap(),
                                detector_id: self.id.clone(),
                                confidence: Confidence::new(99).unwrap(),
                                validation: ValidationLevel::ContextCorrelated,
                                location: Some(location),
                                severity: Severity::Critical,
                            });
                        }
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
    fn test_aws_approved_fixture_boundaries_and_correlation() {
        let detector = AwsDetector::new();
        // Fragmented reconstruction to avoid triggering secret scanners
        let access_key = format!("{}{}", "AKIAIOSFOD", "NN7EXAMPLE");
        let secret_key = format!("{}{}{}", "wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY");

        // 1. Standalone Access Key matches
        let standalone_input = format!("Key: {}", access_key);
        let detections = detector.inspect(&SensitiveText::new(standalone_input));
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].kind.as_str(), "aws_access_key_id");
        assert_eq!(detections[0].severity, Severity::High);

        // 2. Context Correlated Pair matches
        let pair_input = format!(
            "aws_access_key_id = {}\naws_secret_access_key = {}",
            access_key, secret_key
        );
        let detections2 = detector.inspect(&SensitiveText::new(pair_input));
        // We expect one aws_access_key_id and one aws_credential_pair detection for the secret
        assert_eq!(detections2.len(), 2);

        let mut has_pair = false;
        let mut has_id = false;
        for d in detections2 {
            if d.kind.as_str() == "aws_credential_pair" {
                has_pair = true;
                assert_eq!(d.severity, Severity::Critical);
                assert_eq!(d.validation, ValidationLevel::ContextCorrelated);
            }
            if d.kind.as_str() == "aws_access_key_id" {
                has_id = true;
            }
        }
        assert!(has_pair && has_id, "Missing context-correlated detection");

        // 3. No false positive for generic 40 char base64 string without context/access key
        let no_context_input = format!("Just some data: {}", secret_key);
        let detections3 = detector.inspect(&SensitiveText::new(no_context_input));
        assert_eq!(
            detections3.len(),
            0,
            "Should not randomly classify base64 string without AWS context"
        );
    }
}
