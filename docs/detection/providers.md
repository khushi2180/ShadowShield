# Shared Provider Documentation

This document covers shared engineering boundaries and safety policies for all provider-based secret detectors.

## Boundary Policy
To prevent extracting partial credentials from the middle of arbitrary variable names or strings (which frequently occurs when blindly using the `\b` regex word boundary), detectors enforce explicit structural bounds. A provider secret must not be extracted from the middle of a larger ASCII identifier.
All detectors utilize explicit negative lookaround-equivalent structural bounds (e.g., `(?:^|[^A-Za-z0-9_])`) to guarantee that preceding and succeeding characters are strictly non-alphanumeric.

## Candidate Size Safety
Every provider detector enforces a defensive engineering candidate limit. While specific tokens naturally have tighter length bounds within the regex logic itself, a generalized hard ceiling of 64KB (65536 bytes) is enforced inside the extraction logic to prevent pathologically large matching inputs (such as endless binary buffers matching arbitrary base64 characters) from consuming unbounded memory or CPU cycles during inspection.

## Privacy
No external API calls are executed to provider endpoints (GitHub, Slack, AWS, Google, etc.). The detectors perform 100% local analysis. To preserve strict privacy:
- Raw or partial tokens are never stored inside `Detection` output structs.
- Provider secrets are never persisted in logs, telemetry, error traces, or `InspectionResult` payloads.
- All detections only emit generic metadata describing the *kind* of secret identified.
