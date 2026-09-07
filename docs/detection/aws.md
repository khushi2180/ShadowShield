# AWS Credentials Detector

## Authoritative Source
Modeled against official AWS IAM / CLI documentation.

## Supported Detection Kinds
- `aws_access_key_id`: Long-term `AKIA` keys.
- `aws_credential_pair`: A correlated secret-key counterpart detected near an access key.

## Validation Level & Severity
- **aws_access_key_id**: `PatternMatch` with `High` severity.
- **aws_credential_pair**: `ContextCorrelated` with `Critical` severity. 

## Detection Semantics
- **Standalone Access-Key Semantics**: We definitively recognize `AKIA` standard formats.
- **Strong Correlation Semantics**: Base64 40-character strings are heavily prone to false positives if blindly detected. ShadowShield explicitly requires an `AKIA` key to be present in the same block, combined with AWS contextual keywords (e.g., `AWS_ACCESS_KEY_ID`), before elevating a candidate to `aws_credential_pair`.
- **ASIA Temporary Keys**: Support for `ASIA` keys is `BLOCKED_BY_FIXTURE` since no authorized session token testing material exists.
- **Privacy & External Verification**: We execute strictly local tests. We never call AWS APIs. No values are recorded.

## Fixture State & Maturity
- **Maturity (AKIA / Pairs)**: `FixtureVerified` via official AWS examples reconstructed at runtime.
- **Maturity (ASIA / Temp)**: `Implemented` but `FixtureVerified=false` due to missing fixture.
- **Enabled**: `false`.
- **Storage Strategy**: The approved documentation fixture is loaded strictly via string concatenation chunks at runtime (`fragmented_test_runtime`) to prevent matching repository-level secret-scanning heuristics.
