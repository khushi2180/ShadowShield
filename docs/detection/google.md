# Google Detector

## Authoritative Source
Modeled against Google's specification-driven `AIza` identifier structure for API keys.

## Supported Token Families
- `AIza` (google_api_key)

## Detection Kinds
- **DetectionKind**: `google_api_key`
- **Category**: `Secret`

## Validation Level & Severity
- **ValidationLevel**: `PatternMatch`
- **Severity**: `High` (Provisional severity is `High` because the exploitability of a naked Google API key depends heavily on GCP project quota restrictions, HTTP referer protections, and service constraints. It is generally not as universally catastrophic as an unrestricted long-term AWS access pair).

## Fixture State & Maturity
- **Maturity**: `Implemented`
- **FixtureVerified**: `false`
- **Enabled**: `false`
- **Limitations**: Positive credential detection is `BLOCKED_BY_FIXTURE`.

## No External Verification & Privacy
ShadowShield does not verify tokens against Google's OAuth, IAM, or metadata servers. No values are recorded in detection traces.
