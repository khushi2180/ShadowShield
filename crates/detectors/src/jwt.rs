use base64::prelude::*;
use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct JwtDetector {
    id: DetectorId,
    kind: DetectionKind,
}

impl JwtDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("secret.token.jwt").unwrap(),
            kind: DetectionKind::new("jwt").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Compact signed JWT: header.payload.signature
        // Base64URL without padding chars: A-Za-z0-9_-
        // Bounded by non-base64url characters.
        RE.get_or_init(|| {
            Regex::new(r"\b([A-Za-z0-9_\-]+)\.([A-Za-z0-9_\-]+)\.([A-Za-z0-9_\-]+)\b").unwrap()
        })
    }
}

impl Default for JwtDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for JwtDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let full_match = mat.get(0).unwrap();

            // Resource safety: JWTs are typically small.
            // A 64KB bound safely encompasses huge legitimate JWTs while stopping pathological extraction.
            if full_match.len() > 65536 {
                continue;
            }

            let header_b64 = mat.get(1).unwrap().as_str();
            let payload_b64 = mat.get(2).unwrap().as_str();
            let signature_b64 = mat.get(3).unwrap().as_str();

            // Signature must decode successfully as Base64URL and be non-empty
            match BASE64_URL_SAFE_NO_PAD.decode(signature_b64) {
                Ok(bytes) if !bytes.is_empty() => {}
                _ => continue,
            }

            // Base64URL decode protected header
            let header_bytes = match BASE64_URL_SAFE_NO_PAD.decode(header_b64) {
                Ok(bytes) => bytes,
                Err(_) => continue, // Do not wrap or log raw parsing errors
            };

            // Valid UTF-8
            let header_str = match std::str::from_utf8(&header_bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };

            // Parse JSON object
            let header_json: serde_json::Value = match serde_json::from_str(header_str) {
                Ok(json) => json,
                Err(_) => continue,
            };

            if !header_json.is_object() {
                continue;
            }

            // `alg` must exist as a string
            let alg = match header_json.get("alg").and_then(|a| a.as_str()) {
                Some(alg) => alg,
                None => continue,
            };

            if alg.eq_ignore_ascii_case("none") {
                continue;
            }

            // Validate payload is valid base64url and JSON object
            let payload_bytes = match BASE64_URL_SAFE_NO_PAD.decode(payload_b64) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };

            let payload_str = match std::str::from_utf8(&payload_bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let payload_json: serde_json::Value = match serde_json::from_str(payload_str) {
                Ok(json) => json,
                Err(_) => continue,
            };

            if !payload_json.is_object() {
                continue;
            }

            if let Ok(location) = DetectionLocation::new(full_match.start(), full_match.end()) {
                if location.validate_for(text).is_ok() {
                    detections.push(Detection {
                        category: DetectionCategory::Secret,
                        kind: self.kind.clone(),
                        detector_id: self.id.clone(),
                        confidence: Confidence::new(95).unwrap(),
                        validation: ValidationLevel::StructurallyValid,
                        location: Some(location),
                        severity: Severity::High,
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
    fn test_jwt_approved_fixture_boundaries() {
        let detector = JwtDetector::new();
        // RFC 7519 Section 3.1 compact signed JWT
        let jwt = "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

        let test_cases = vec![
            format!(" {}", jwt),
            format!("\"{}\"", jwt),
            format!("'{}'", jwt),
            format!("({})", jwt),
            format!("[{}]", jwt),
            format!("Token: {}, please verify.", jwt),
        ];

        for input in test_cases {
            let text = SensitiveText::new(input.clone());
            let detections = detector.inspect(&text);
            assert_eq!(detections.len(), 1, "Failed on input: {}", input);

            let detection = &detections[0];
            assert_eq!(detection.category, DetectionCategory::Secret);
            assert_eq!(detection.kind.as_str(), "jwt");
            assert_eq!(detection.validation, ValidationLevel::StructurallyValid);
            assert_eq!(detection.severity, Severity::High);
            assert_eq!(detection.confidence.value(), 95);

            let loc = detection.location.unwrap();
            assert!(loc.validate_for(text.expose()).is_ok());

            // Verify exact boundary extraction
            let extracted = &text.expose()[loc.start_byte()..loc.end_byte()];
            assert_eq!(extracted, jwt);
        }
    }
}
