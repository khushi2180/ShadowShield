# Aadhaar Detector

## Authoritative Source
Modeled against official UIDAI structural formats and the standard Verhoeff checksum algorithm.

## Architecture & Validation Level
- **Architecture**: Discovers candidate strings using structural constraints (e.g. no leading 0 or 1, exactly 12 digits, optional common formatting hyphens/spaces), followed by full Verhoeff checksum logic.
- **ValidationLevel**: `ChecksumValid`
- **Severity**: `High`

## Verhoeff Checksum Implementation
We implement a small, offline internal Verhoeff table matrix rather than adopting an external dependency solely for mathematical multiplication. This allows perfect isolation.

## Fixture State & Maturity
- **Maturity**: `Implemented`
- **FixtureVerified**: `false`
- **Enabled**: `false`
- **Limitations**: Positive credential testing is `BLOCKED_BY_FIXTURE` since no explicitly maintainer-approved official Aadhaar testing fixture is available. We absolutely will not generate synthetic Aadhaar numbers merely to pass the checksum.

## No External Verification & Privacy
ShadowShield executes local-first checksum checks. We absolutely DO NOT invoke UIDAI authentication APIs. Checksum validity merely implies a mathematically plausible entry; it never claims the identity exists or is active. We record zero raw values.
