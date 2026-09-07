use regex::Regex;
use std::sync::OnceLock;
use url::Url;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId, SensitiveText,
    Severity, ValidationLevel,
};

use crate::Detector;

pub struct DatabaseCredentialDetector {
    id: DetectorId,
}

impl DatabaseCredentialDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("credential.database.connection_uri").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // A rough initial pass to find URI-like structures before formal parsing
        RE.get_or_init(|| Regex::new(
            r#"(?i)(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis)://[^\s\"'<>]+"#
        ).unwrap())
    }

    fn supported_schemes() -> &'static [&'static str] {
        &[
            "postgres", "postgresql", "mysql", "mongodb", "mongodb+srv", "redis"
        ]
    }
}

impl Default for DatabaseCredentialDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for DatabaseCredentialDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let candidate_match = mat.get(0).unwrap();
            let candidate = candidate_match.as_str();

            if candidate.len() > 65536 {
                continue;
            }

            // Perform formal URI parsing
            if let Ok(parsed_url) = Url::parse(candidate) {
                // Check if scheme is in our supported list
                if !Self::supported_schemes().contains(&parsed_url.scheme().to_lowercase().as_str()) {
                    continue;
                }

                // Check if the URI actually embeds authentication secrets
                // We require a password to consider it a credential leak (not just a public database reference)
                if parsed_url.password().is_some() {
                    if let Ok(location) = DetectionLocation::new(candidate_match.start(), candidate_match.end()) {
                        if location.validate_for(text).is_ok() {
                            detections.push(Detection {
                                category: DetectionCategory::Credential,
                                kind: DetectionKind::new("database_credential").unwrap(),
                                detector_id: self.id.clone(),
                                confidence: Confidence::new(95).unwrap(),
                                validation: ValidationLevel::StructurallyValid,
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
    fn test_database_credential_parsing_logic() {
        let detector = DatabaseCredentialDetector::new();
        // Positive credential testing is BLOCKED_BY_FIXTURE.
        // Testing that URIs WITHOUT passwords are systematically ignored.
        let safe_uri = SensitiveText::new("postgres://localhost:5432/mydb".to_string());
        let detections = detector.inspect(&safe_uri);
        assert_eq!(detections.len(), 0, "Should ignore URIs without passwords");

        let user_only_uri = SensitiveText::new("mysql://admin@localhost/db".to_string());
        let user_only_detections = detector.inspect(&user_only_uri);
        assert_eq!(user_only_detections.len(), 0, "Should ignore URIs with only usernames");
    }
}
