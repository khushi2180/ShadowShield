use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct GithubDetector {
    id: DetectorId,
}

impl GithubDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("secret.github.token").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // GitHub prefixes: ghp_, github_pat_, gho_, ghu_, ghs_, ghr_
        // Using structural boundaries `(?:^|[^A-Za-z0-9_])` prevents matching inside larger variables.
        // The token body allows alphanumeric, underscores, hyphens, and dots.
        // The `ghs_APPID_JWT` stateless transition precludes strict historical fixed length checks (e.g. 40 chars).
        // Defensive limit max 255 chars.
        RE.get_or_init(|| Regex::new(
            r"(?:^|[^A-Za-z0-9_])((?:gh[pousr]_|github_pat_)[A-Za-z0-9_\-\.]{10,255})(?:$|[^A-Za-z0-9_])"
        ).unwrap())
    }

    fn determine_kind(prefix: &str) -> DetectionKind {
        let kind_str = match prefix {
            "ghp_" => "github_personal_access_token",
            "github_pat_" => "github_fine_grained_pat",
            "gho_" => "github_oauth_token",
            "ghu_" => "github_user_access_token",
            "ghs_" => "github_installation_access_token",
            "ghr_" => "github_refresh_token",
            _ => "github_token",
        };
        DetectionKind::new(kind_str).unwrap()
    }
}

impl Default for GithubDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for GithubDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let candidate_match = mat.get(1).unwrap();
            let candidate = candidate_match.as_str();

            // Extract prefix for exact kind mapping
            let prefix = if candidate.starts_with("github_pat_") {
                "github_pat_"
            } else {
                &candidate[0..4]
            };
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
                        confidence: Confidence::new(97).unwrap(), // Provisional deterministic
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
    fn test_github_prefix_mapping_without_secrets() {
        let detector = GithubDetector::new();
        // Positive credential detection is BLOCKED_BY_FIXTURE.
        // We solely test that the regex handles structural boundary matching and correctly routes the prefix.
        let test_cases = vec![
            ("ghp_1234567890", "github_personal_access_token"),
            ("github_pat_1234567890", "github_fine_grained_pat"),
            ("gho_1234567890", "github_oauth_token"),
            ("ghu_1234567890", "github_user_access_token"),
            ("ghs_1234567890.JWT", "github_installation_access_token"),
            ("ghr_1234567890", "github_refresh_token"),
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
