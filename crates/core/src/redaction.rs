use shadowshield_protocol::{Detection, SanitizedText, SensitiveText};

#[derive(Debug, PartialEq, Eq)]
pub enum RedactionError {
    InvalidLocationRange,
    Utf8BoundaryError,
}

pub struct RedactionEngine {}

impl RedactionEngine {
    pub fn new() -> Self {
        Self {}
    }

    pub fn redact(
        &self,
        content: &SensitiveText,
        detections: &[Detection],
    ) -> Result<SanitizedText, RedactionError> {
        let text = content.expose();

        if detections.is_empty() {
            return Ok(SanitizedText::new(text.to_string()));
        }

        // Collect and validate all valid detection locations
        let mut ranges = Vec::new();
        for detection in detections {
            if let Some(loc) = &detection.location {
                if loc.validate_for(text).is_err() {
                    return Err(RedactionError::Utf8BoundaryError);
                }
                ranges.push((loc.start_byte(), loc.end_byte(), detection.kind.as_str()));
            }
        }

        // Sort ranges by start_byte, descending, to allow right-to-left replacement
        // This handles duplicates inherently during the merge pass.
        // But first, we sort ascending to easily merge overlapping ranges
        ranges.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        // Merge overlapping or touching ranges
        let mut merged_ranges: Vec<(usize, usize, String)> = Vec::new();
        for (start, end, kind) in ranges {
            if let Some(last) = merged_ranges.last_mut() {
                if start <= last.1 {
                    // Overlapping or touching
                    last.1 = std::cmp::max(last.1, end);
                    // If kinds differ, use a generic identifier
                    if last.2 != kind {
                        last.2 = "SENSITIVE_DATA".to_string();
                    }
                    continue;
                }
            }
            merged_ranges.push((start, end, kind.to_string()));
        }

        // Now replace right-to-left
        let mut output = text.to_string();
        for (start, end, kind) in merged_ranges.into_iter().rev() {
            let placeholder = format!("[REDACTED:{}]", kind.to_ascii_uppercase());
            // Safe replacement because we validated char boundaries and merged overlapping slices
            output.replace_range(start..end, &placeholder);
        }

        Ok(SanitizedText::new(output))
    }
}

impl Default for RedactionEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shadowshield_protocol::{
        Confidence, DetectionCategory, DetectionKind, DetectionLocation, DetectorId, Severity,
        ValidationLevel,
    };

    fn make_det(start: usize, end: usize, kind: &str) -> Detection {
        Detection {
            category: DetectionCategory::TestStructural,
            kind: DetectionKind::new(kind).unwrap(),
            detector_id: DetectorId::new("test.det").unwrap(),
            confidence: Confidence::new(100).unwrap(),
            validation: ValidationLevel::PatternMatch,
            location: Some(DetectionLocation::new(start, end).unwrap()),
            severity: Severity::Medium,
        }
    }

    #[test]
    fn test_redaction_single_range() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("My email is test@example.com.".to_string());
        // "test@example.com" is at 12..28
        let dets = vec![make_det(12, 28, "email_address")];

        let sanitized = engine.redact(&text, &dets).unwrap();
        assert_eq!(sanitized.expose(), "My email is [REDACTED:EMAIL_ADDRESS].");
    }

    #[test]
    fn test_redaction_multiple_non_overlapping() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("User alice and bob are here.".to_string());
        let dets = vec![
            make_det(5, 10, "user_id"),  // alice
            make_det(15, 18, "user_id"), // bob
        ];

        let sanitized = engine.redact(&text, &dets).unwrap();
        assert_eq!(
            sanitized.expose(),
            "User [REDACTED:USER_ID] and [REDACTED:USER_ID] are here."
        );
    }

    #[test]
    fn test_redaction_overlapping_same_kind() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("hello overlapping world".to_string());
        // 6..17 (overlapping)
        // 10..20 (pping worl)
        let dets = vec![
            make_det(6, 17, "secret_key"),
            make_det(10, 20, "secret_key"),
        ];

        let sanitized = engine.redact(&text, &dets).unwrap();
        assert_eq!(sanitized.expose(), "hello [REDACTED:SECRET_KEY]rld"); // merged to 6..20
    }

    #[test]
    fn test_redaction_overlapping_different_kinds() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("hello overlapping world".to_string());
        let dets = vec![make_det(6, 17, "secret_key"), make_det(10, 20, "api_key")];

        let sanitized = engine.redact(&text, &dets).unwrap();
        assert_eq!(sanitized.expose(), "hello [REDACTED:SENSITIVE_DATA]rld"); // merged to 6..20 with generic kind
    }

    #[test]
    fn test_redaction_duplicate_ranges() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("duplicate duplicate".to_string());
        let dets = vec![make_det(0, 9, "some_key"), make_det(0, 9, "some_key")];

        let sanitized = engine.redact(&text, &dets).unwrap();
        assert_eq!(sanitized.expose(), "[REDACTED:SOME_KEY] duplicate");
    }

    #[test]
    fn test_redaction_unicode_boundaries() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("Hello, 世界".to_string());
        let dets = vec![
            make_det(7, 10, "chinese_char"), // Valid
        ];

        let sanitized = engine.redact(&text, &dets).unwrap();
        assert_eq!(sanitized.expose(), "Hello, [REDACTED:CHINESE_CHAR]界");
    }

    #[test]
    fn test_redaction_invalid_utf8_boundaries() {
        let engine = RedactionEngine::new();
        let text = SensitiveText::new("Hello, 世界".to_string());
        let dets = vec![
            make_det(7, 8, "chinese_char"), // Invalid mid-char boundary
        ];

        let err = engine.redact(&text, &dets).unwrap_err();
        assert_eq!(err, RedactionError::Utf8BoundaryError);
    }
}
