use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId,
    SensitiveText, Severity, ValidationLevel,
};

use crate::Detector;

pub struct PaymentCardDetector {
    id: DetectorId,
    kind: DetectionKind,
}

impl PaymentCardDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.financial.payment_card").unwrap(),
            kind: DetectionKind::new("payment_card_number").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Candidate discovery looks for bounded sequences of digits, spaces, and hyphens.
        // It requires a word boundary at both ends, ensuring it won't extract a 16-digit substring
        // from a 20-digit continuous numeric sequence.
        RE.get_or_init(|| Regex::new(r"\b\d[\d \-]{11,30}\d\b").unwrap())
    }

    fn is_reasonably_formatted(candidate: &str) -> bool {
        let mut has_space = false;
        let mut has_hyphen = false;
        let mut prev_was_sep = false;

        for c in candidate.chars() {
            if c == ' ' || c == '-' {
                if prev_was_sep {
                    // Reject repeated consecutive separators
                    return false;
                }
                if c == ' ' {
                    has_space = true;
                } else {
                    has_hyphen = true;
                }
                prev_was_sep = true;
            } else if c.is_ascii_digit() {
                prev_was_sep = false;
            } else {
                // Reject if somehow a non-digit/non-separator got here
                return false;
            }
        }

        // Reject mixed separator usage
        if has_space && has_hyphen {
            return false;
        }

        true
    }

    fn luhn_valid(normalized: &str) -> bool {
        let mut sum = 0;
        let mut alternate = false;

        for ch in normalized.chars().rev() {
            if let Some(mut digit) = ch.to_digit(10) {
                if alternate {
                    digit *= 2;
                    if digit > 9 {
                        digit -= 9;
                    }
                }
                sum += digit;
                alternate = !alternate;
            } else {
                return false; // Should not happen since we normalize to digits
            }
        }
        sum > 0 && sum % 10 == 0
    }
}

impl Default for PaymentCardDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for PaymentCardDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().find_iter(text) {
            let candidate = mat.as_str();

            // Formatting validation
            if !Self::is_reasonably_formatted(candidate) {
                continue;
            }

            // Normalization: strip explicitly supported separators (spaces and hyphens)
            let normalized: String = candidate.chars().filter(|c| c.is_ascii_digit()).collect();

            // Length sanity: practical PAN length bounds are 13 to 19 digits.
            // This firmly rejects 10-digit phone numbers or 20-digit strings.
            if normalized.len() < 13 || normalized.len() > 19 {
                continue;
            }

            // Structural checksum
            if Self::luhn_valid(&normalized) {
                if let Ok(location) = DetectionLocation::new(mat.start(), mat.end()) {
                    if location.validate_for(text).is_ok() {
                        detections.push(Detection {
                            category: DetectionCategory::Pii,
                            kind: self.kind.clone(),
                            detector_id: self.id.clone(),
                            // Provisional deterministic engineering confidence
                            confidence: Confidence::new(95).unwrap(),
                            validation: ValidationLevel::ChecksumValid,
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
    fn test_payment_card_approved_fixtures_boundaries() {
        let detector = PaymentCardDetector::new();
        // Approved fixtures:
        // Visa: 4111 1111 1111 1111
        // Mastercard: 5555 5555 5555 4444
        // Amex: 3700 0000 0000 002

        let test_cases = vec![
            // Official space-separated representations
            (" 4111 1111 1111 1111 ", "4111 1111 1111 1111"),
            ("(5555 5555 5555 4444)", "5555 5555 5555 4444"),
            ("Card: 3700 0000 0000 002.", "3700 0000 0000 002"),
            // Normalized continuous representations (exact same digit sequence)
            ("4111111111111111", "4111111111111111"),
            ("5555555555554444", "5555555555554444"),
            ("370000000000002", "370000000000002"),
            // Hyphen-separated representations (exact same digit sequence)
            ("4111-1111-1111-1111", "4111-1111-1111-1111"),
            ("3700-0000-0000-002", "3700-0000-0000-002"),
        ];

        for (input, expected) in test_cases {
            let text = SensitiveText::new(input.to_string());
            let detections = detector.inspect(&text);
            assert_eq!(detections.len(), 1, "Failed on input: {}", input);

            let detection = &detections[0];
            assert_eq!(detection.category, DetectionCategory::Pii);
            assert_eq!(detection.kind.as_str(), "payment_card_number");
            assert_eq!(detection.validation, ValidationLevel::ChecksumValid);
            assert_eq!(detection.severity, Severity::High);
            assert_eq!(detection.confidence.value(), 95);

            let loc = detection.location.unwrap();
            assert!(loc.validate_for(text.expose()).is_ok());

            // Verify exactly the approved representation is extracted, excluding wrappers
            let extracted = &text.expose()[loc.start_byte()..loc.end_byte()];
            assert_eq!(extracted, expected);
        }
    }

    #[test]
    fn test_payment_card_malformed_formatting_rejected() {
        let detector = PaymentCardDetector::new();

        // Constructing malformed formats purely out of the officially approved Visa PAN digit sequence
        let test_cases = vec![
            "4111  1111  1111  1111", // Repeated spaces
            "4111--1111--1111--1111", // Repeated hyphens
            "4111 1111-1111 1111",    // Mixed separators
                                      // Note: leading/trailing separators are already avoided by regex bounds `\d...\d`
        ];

        for input in test_cases {
            let text = SensitiveText::new(input.to_string());
            let detections = detector.inspect(&text);
            assert_eq!(
                detections.len(),
                0,
                "Should have rejected malformed formatting: {}",
                input
            );
        }
    }
}
