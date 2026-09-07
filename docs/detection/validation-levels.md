# Validation Levels

ShadowShield employs explicit validation levels to describe how confidently a detection was validated locally:

- **PatternMatch**: The candidate matched a deterministic pattern (e.g., regex).
- **StructurallyValid**: The candidate passed structural parsing or format checks.
- **ChecksumValid**: The candidate passed an applicable deterministic checksum (e.g., Luhn).
- **ContextCorrelated**: Multiple independent pieces of local evidence were correlated.

### Why "Verified" is Intentionally Absent
ShadowShield V1 must not imply that local structural validation proves a credential or identifier is active/live. Antigravity and local detectors cannot and must not transmit credentials to external providers merely to validate them.
