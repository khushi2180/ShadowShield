use base64::prelude::*;
use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct PrivateKeyDetector {
    id: DetectorId,
    kind: DetectionKind,
}

impl PrivateKeyDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("secret.cryptographic.private_key").unwrap(),
            kind: DetectionKind::new("private_key").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Rust's regex engine intentionally does not support backreferences to prevent catastrophic backtracking.
        // Therefore, we capture the BEGIN label and the END label independently and assert equality in Rust.
        // `(?s)` allows `.` or character classes containing whitespace to span multiple lines.
        // `[A-Za-z0-9+/=\s]+?` matches base64 body minimally to prevent consuming multiple keys into one.
        RE.get_or_init(|| Regex::new(
            r"(?s)-----BEGIN (PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END (PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----"
        ).unwrap())
    }
}

impl Default for PrivateKeyDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for PrivateKeyDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let full_match = mat.get(0).unwrap();

            // Resource safety bounds: PEM blocks are typically 1-4KB.
            // Reject pathological regex extractions beyond a safe 64KB bound.
            if full_match.len() > 65536 {
                continue;
            }

            let label_begin = mat.get(1).unwrap().as_str();
            let body = mat.get(2).unwrap().as_str();
            let label_end = mat.get(3).unwrap().as_str();

            // Explicitly enforce that BEGIN and END labels match precisely
            if label_begin != label_end {
                continue;
            }

            // Normalize multiline textual body by stripping all ASCII whitespace ONLY.
            // RFC 7468 dictates that whitespace is ignored.
            // Non-base64 characters (e.g. rogue punctuation) MUST fail to decode.
            let clean_body: String = body.chars().filter(|c| !c.is_ascii_whitespace()).collect();

            // Base64 decode the body natively.
            // BASE64_STANDARD will elegantly Error if rogue non-base64 characters persist.
            match BASE64_STANDARD.decode(&clean_body) {
                Ok(bytes) if !bytes.is_empty() => {
                    if let Ok(location) =
                        DetectionLocation::new(full_match.start(), full_match.end())
                    {
                        if location.validate_for(text).is_ok() {
                            detections.push(Detection {
                                category: DetectionCategory::Secret,
                                kind: self.kind.clone(),
                                detector_id: self.id.clone(),
                                // Provisional deterministic engineering confidence (highly structured payload)
                                confidence: Confidence::new(98).unwrap(),
                                validation: ValidationLevel::StructurallyValid,
                                location: Some(location),
                                severity: Severity::Critical,
                            });
                        }
                    }
                }
                _ => continue, // Do not wrap or log raw parsing errors
            }
        }
        detections
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_private_key_approved_fixture_boundaries() {
        let detector = PrivateKeyDetector::new();
        // RFC 8410 private-key textual-encoding example
        let pk = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\n-----END PRIVATE KEY-----";

        // RFC 7468 Figure 13 PKCS #8 EncryptedPrivateKeyInfo Example
        let enc_pk = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIHNMEAGCSqGSIb3DQEFDTAzMBsGCSqGSIb3DQEFDDAOBAghhICA6T/51QICCAAw\nFAYIKoZIhvcNAwcECBCxDgvI59i9BIGIY3CAqlMNBgaSI5QiiWVNJ3IpfLnEiEsW\nZ0JIoHyRmKK/+cr9QPLnzxImm0TR9s4JrG3CilzTWvb0jIvbG3hu0zyFPraoMkap\n8eRzWsIvC5SVel+CSjoS2mVS87cyjlD+txrmrXOVYDE+eTgMLbrLmsWh3QkCTRtF\nQC7k0NNzUHTV9yGDwfqMbw==\n-----END ENCRYPTED PRIVATE KEY-----";

        let test_cases = vec![
            (format!("Here is the key:\n\n{}\nKeep it safe.", pk), pk),
            (format!("{}\n", enc_pk), enc_pk),
            (format!("    {}    ", pk), pk),
        ];

        for (input, expected) in test_cases {
            let text = SensitiveText::new(input.clone());
            let detections = detector.inspect(&text);
            assert_eq!(detections.len(), 1, "Failed on input: {}", input);

            let detection = &detections[0];
            assert_eq!(detection.category, DetectionCategory::Secret);
            assert_eq!(detection.kind.as_str(), "private_key");
            assert_eq!(detection.validation, ValidationLevel::StructurallyValid);
            assert_eq!(detection.severity, Severity::Critical);
            assert_eq!(detection.confidence.value(), 98);

            let loc = detection.location.unwrap();
            assert!(loc.validate_for(text.expose()).is_ok());

            // Verify exact boundary extraction
            let extracted = &text.expose()[loc.start_byte()..loc.end_byte()];
            assert_eq!(extracted, expected);
        }
    }
}
