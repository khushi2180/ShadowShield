# ADR-009: Detection Location Representation

## Context
When a detector finds a sensitive string (e.g., an API key), it needs to report where it found it. Text can be represented with character indexing or byte indexing.

## Decision
We use a `DetectionLocation` struct with `start_byte` and `end_byte` as `usize` values. These are explicitly UTF-8 byte offsets.

## Consequences
* Byte indexing is native to Rust strings and slicing operations.
* Directly compatible with Rust's O(1) string slicing without traversing characters.
* Arbitrary `usize` values are not automatically valid string boundaries.
* Validation against the source content is strictly required before slicing or redaction. We implemented `validate_for(&self, content: &str) -> Result<(), &'static str>` to guarantee boundaries fall on valid UTF-8 code points and are within bounds.

## Status
Accepted
