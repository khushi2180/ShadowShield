# Indian PAN Detector

## Authoritative Source
Modeled against official Indian Income Tax Department PAN format structure.

## Architecture & Validation Level
- **Architecture**: Extracts 10-character alphanumeric sequences (`[A-Z]{5}[0-9]{4}[A-Z]`) bounded by structural limits, followed by validation.
- **ValidationLevel**: `StructurallyValid`. We verify the 4th character officially identifies a valid status entity (P, C, H, F, A, T, B, L, J, G).
- **Severity**: `High`

## Fixture State & Maturity
- **Maturity**: `Implemented`
- **FixtureVerified**: `false`
- **Enabled**: `false`
- **Limitations**: Positive credential testing is `BLOCKED_BY_FIXTURE` since no explicitly maintainer-approved official PAN fixture exists.

## No External Verification & Privacy
ShadowShield executes local-first structural checks. We absolutely DO NOT invoke the Income Tax Department or any identity verification APIs. No raw identifiers or metadata indicating account existence are recorded. The detection only claims structural validity, not that the identity is real or active.
