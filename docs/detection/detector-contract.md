# Detector Contract

## Responsibilities
- Receives purely isolated access to `SensitiveText`.
- Deterministically identifies patterns or structures indicating sensitive data.
- Emits non-sensitive `Detection` objects containing metadata about what was found.

## Non-responsibilities
- Detectors do **not** evaluate risk.
- Detectors do **not** make policy decisions.
- Detectors do **not** perform network requests, file I/O, or telemetry emission.

## Sensitive-content handling
Detectors must deliberately request access to the raw content by calling `content.expose()`.
The resulting `Detection` output strictly prohibits including the raw matched value or substrings of the raw prompt.
