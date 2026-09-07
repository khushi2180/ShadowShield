use regex::Regex;
use std::sync::OnceLock;

use shadowshield_protocol::{
    Confidence, Detection, DetectionCategory, DetectionKind, DetectionLocation, DetectorId, SensitiveText,
    Severity, ValidationLevel,
};

use crate::Detector;

pub struct AadhaarDetector {
    id: DetectorId,
}

impl AadhaarDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.india.aadhaar").unwrap(),
        }
    }

    fn regex() -> &'static Regex {
        static RE: OnceLock<Regex> = OnceLock::new();
        // Discovers 12 digits, potentially grouped by spaces or hyphens (e.g. 1234 5678 9012 or 1234-5678-9012)
        // Aadhaar numbers do not start with 0 or 1.
        RE.get_or_init(|| Regex::new(
            r"(?:^|[^0-9])([2-9][0-9]{3}[ \-]?[0-9]{4}[ \-]?[0-9]{4})(?:$|[^0-9])"
        ).unwrap())
    }

    // Standard Verhoeff multiplication table
    const D: [[u8; 10]; 10] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
        [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
        [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
        [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
        [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
        [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
        [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
        [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    ];

    // Standard Verhoeff permutation table
    const P: [[u8; 10]; 8] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
        [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
        [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
        [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
        [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
        [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
        [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
    ];

    fn is_verhoeff_valid(normalized: &str) -> bool {
        if normalized.len() != 12 {
            return false;
        }

        let mut c = 0;
        let mut i = 0;
        
        // Reverse iteration over the digits
        for ch in normalized.chars().rev() {
            if let Some(digit) = ch.to_digit(10) {
                let digit_u8 = digit as u8;
                let p_val = Self::P[i % 8][digit_u8 as usize];
                c = Self::D[c as usize][p_val as usize];
                i += 1;
            } else {
                return false;
            }
        }
        c == 0
    }
}

impl Default for AadhaarDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for AadhaarDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, content: &SensitiveText) -> Vec<Detection> {
        let text = content.expose();
        let mut detections = Vec::new();

        for mat in Self::regex().captures_iter(text) {
            let candidate_match = mat.get(1).unwrap();
            let candidate = candidate_match.as_str();

            // Normalize supported separators
            let normalized = candidate.replace([' ', '-'], "");

            if Self::is_verhoeff_valid(&normalized) {
                if let Ok(location) = DetectionLocation::new(candidate_match.start(), candidate_match.end()) {
                    if location.validate_for(text).is_ok() {
                        detections.push(Detection {
                            category: DetectionCategory::Pii,
                            kind: DetectionKind::new("aadhaar_number").unwrap(),
                            detector_id: self.id.clone(),
                            confidence: Confidence::new(90).unwrap(),
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
    fn test_aadhaar_verhoeff_logic() {
        // Positive credential testing is BLOCKED_BY_FIXTURE.
        // We test only the internal Verhoeff checksum calculation structure with structurally invalid permutations.
        assert!(AadhaarDetector::is_verhoeff_valid("123456789012") == false); 
    }
}
