# Redaction Engine

## Objective
The Redaction Engine produces a sanitized string representation of `SensitiveText` without mutating the original text. It safely replaces sensitive detector matches with category-aware placeholders.

## Placeholder Generation
Replaced strings use canonical detection kinds formatted into placeholders: `[REDACTED:<KIND_UPPERCASE>]`. 
For example, `[REDACTED:PAYMENT_CARD_NUMBER]`.

## Mechanics
- **Right-to-Left Replacements**: Detection locations rely on byte offsets against the original string. To prevent offset corruption as string lengths change, redaction iterates through ranges in reverse order (right-to-left).
- **Unicode Safety**: Before any replacement occurs, all byte ranges are strictly validated against UTF-8 character boundaries. Invalid boundaries result in a typed error (`RedactionError::Utf8BoundaryError`) rather than an application panic.
- **Overlap Handling**: Overlapping or touching replacement ranges are sorted ascending and merged deterministically. If overlapping ranges belong to differing detection kinds, the engine falls back to a generic `[REDACTED:SENSITIVE_DATA]` placeholder to prevent confusion.
- **De-duplication**: Identical ranges are natively folded into a single replacement during the overlap merge pass.

## Privacy
No before-and-after string content is recorded in telemetry. Extracted matches are transient variables destroyed locally. 
