# Payment Card Detector

## Purpose
Detect deterministic payment-card-number (PAN) candidates.

## Candidate Discovery
Uses a candidate discovery regex (`\b\d[\d \-]{11,30}\d\b`) to locate strings bounded by non-numeric and non-separator characters. This safely captures strings containing digits, spaces, and hyphens without accidentally consuming a 16-digit substring from a continuous 20-digit numeric sequence.

## Normalization and Length Sanity
Candidates are normalized transiently by removing explicitly supported separators (spaces and hyphens). The normalized continuous digit sequence is checked against broadly accepted PAN length bounds (13 to 19 digits).

## Luhn Algorithm
The candidate is subjected to a local Luhn (Modulus 10) checksum evaluation over the normalized digits. No network validation or BIN lookup is performed.

## Validation Level
**ChecksumValid**: The candidate passed structural length checks and mathematically satisfied the deterministic Luhn checksum.

## Provisional Confidence
**95**: Provisional deterministic engineering confidence, representing high certainty of a structural match, not an empirical probability.

## Provisional Severity
**High**

## Detection Location Semantics
The `DetectionLocation` captures the entire discovered representation (including internal hyphens and spaces) but safely excludes surrounding punctuation or neutral prose.

## Privacy Behavior
The PAN, its normalized form, or partial digits are strictly excluded from `Detection`, telemetry, and logs. Masking functionality is reserved for Phase 1D; currently, only the metadata event is emitted.

## Fixture Provenance
The test framework strictly uses explicitly approved test PANs provided by Adyen (official test-card documentation). No negative (failed-Luhn) fixtures have been fabricated.

## Known Limitations
`ChecksumValid` does NOT mean verified, real, or active. ShadowShield deliberately does not attempt brand classification (Visa, Mastercard, etc.) as the core DLP requirement operates on the aggregate category. Negative Luhn testing coverage is currently limited because Antigravity is prohibited from fabricating negative fixtures.
