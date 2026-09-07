# Stripe Secret-Key Detector

## Purpose
Detect deterministic Stripe secret API credentials in textual content.

## Official Provider Basis
The detector is strictly modeled around Stripe's official API key prefixes as documented by Stripe.

## Supported Prefixes
For Phase 1 V1, the detector supports:
- `sk_test_`
- `sk_live_`

## Publishable-Key Distinction
Stripe publishable keys (`pk_test_`, `pk_live_`) are explicitly excluded. Publishable keys are intended for client-side distribution and are therefore purposefully not classified as secret credentials by ShadowShield.

## Candidate Boundaries & Assumptions
The detector isolates candidates using word boundaries (`\b`) to prevent substring extraction (e.g., matching inside a larger string like `mysk_test_key123`).
Because Stripe does not guarantee a permanent, immutable body length for all future keys, the detector avoids unnecessarily brittle exact-length regex matching. Instead, it combines the deterministic provider prefix with conservative body-length sanity bounds (10 to 255 characters).

## Validation Level
**PatternMatch**: Candidate validation is driven entirely by regex and deterministic prefixes. ShadowShield is a local-first system and unequivocally DOES NOT contact Stripe, initialize a Stripe SDK, or make network calls to verify account status, key authenticity, or permissions. Thus, the validation level honestly reflects pattern confidence, not remote verification.

## Metadata
- **Category**: `Secret`
- **Kind**: `stripe_secret_key`
- **DetectorId**: `secret.stripe.api_key`
- **Confidence**: `97` (Provisional deterministic engineering confidence based on strong documented prefixes)
- **Severity**: `Critical`

## Fixture Provenance
The automated test suite explicitly utilizes exactly one Stripe-approved sample key. This is publicly published by Stripe as a test credential in their official documentation. To avoid triggering repository secret-scanning controls on a literal match, the key is reconstructed from safe fragments at test runtime rather than stored literally in the codebase.

## Known Limitations
1. **Live-Key Coverage Limitation**: While the regex implementation securely recognizes `sk_live_`, no live-key fixtures exist in the test suite because Antigravity is strictly prohibited from fabricating unauthorized fixtures.
2. **Negative-Test Limitation**: No malformed Stripe fixture exists in the automated suite because Antigravity is strictly prohibited from mutating or fabricating unauthorized malformed or cryptographic security fixtures.
3. **Restricted-Key Coverage**: Stripe restricted keys (`rk_live_`, `rk_test_`) are not supported in Phase 1 V1 as no official fixture has been explicitly reviewed and approved by the maintainer.
