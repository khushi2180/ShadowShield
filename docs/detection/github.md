# GitHub Detector

## Authoritative Source
Modeled against official GitHub authentication documentation.

## Supported Token Families
- `ghp_` (github_personal_access_token)
- `github_pat_` (github_fine_grained_pat)
- `gho_` (github_oauth_token)
- `ghu_` (github_user_access_token)
- `ghs_` (github_installation_access_token)
- `ghr_` (github_refresh_token)

## Detection Kinds
Maps each prefix to its corresponding `DetectionKind`. `Category` is `Secret`.

## Validation Level & Severity
- **ValidationLevel**: `PatternMatch`
- **Severity**: `Critical`

## Candidate Assumptions & Evolving Formats
GitHub token architecture is actively evolving. As of 2026, GitHub started introducing stateless installation tokens (`ghs_APPID_JWT`). As a result, the detector avoids relying on historical fixed-length regex bounds (e.g. exactly 40 chars) which are overly brittle. The detector enforces documented prefixes with defensive bounds (10 to 255 chars).

## Fixture State & Maturity
- **Maturity**: `Implemented`
- **FixtureVerified**: `false`
- **Enabled**: `false`
- **Limitations**: Positive credential detection is `BLOCKED_BY_FIXTURE`.

## No External Verification & Privacy
ShadowShield executes local-first structural checks. It absolutely does NOT invoke the GitHub API to authenticate, validate, or inspect tokens. The `Detection` object contains zero bits of the raw string, ensuring perfect privacy isolation from analytics or logs.
