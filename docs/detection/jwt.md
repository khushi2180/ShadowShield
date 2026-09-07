# JWT Detector

## Purpose
Detect deterministic JSON Web Token (JWT) and JSON Web Signature (JWS) secrets in textual content.

## RFC Basis
- JWT: RFC 7519
- JWS: RFC 7515

## Candidate Discovery
Uses a regex to extract candidates containing exactly three segments (header, payload, signature) bounded by dots (`.`). Base64URL characters (A-Za-z0-9_-) are strictly enforced without padding. 
To prevent pathological candidate processing and resource exhaustion, candidate length is reasonably bounded to 64KB, which safely encompasses huge legitimate JWTs while discarding abusive inputs.

## Structural Validation
The first segment (protected header), second segment (payload), and third segment (signature) are strictly validated:
1. Base64URL decoding (unpadded).
2. UTF-8 conversion (for header and payload).
3. JSON object parsing (for header and payload).
The header must be a JSON object containing an `alg` string that is NOT `"none"`.

## Scope and Limitations
**Supported**:
- Compact signed JWT/JWS (three segments).

**Unsupported (Phase 1 V1)**:
- JWE (JSON Web Encryption).
- Five-segment JWTs.
- Nested JWTs.
- Unsecured JWTs (`alg="none"`).
- Detached JWS.
- JSON JWS serialization format.
- Cryptographic signature verification.

## Validation Semantics
Passing this detector means the JWT exactly passes ShadowShield's supported compact signed JWT structural checks. 

This detector absolutely DOES NOT prove:
- full JOSE conformance
- cryptographic validity
- signature validity
- token authenticity
- issuer validity
- claims validity

## Validation Level
**StructurallyValid**: The candidate passed Base64URL decoding and JSON validation for both the header and payload, an algorithm exists, and the signature successfully decodes via Base64URL.

## Privacy Behavior
- Raw JWT strings, decoded headers, decoded payloads, claims, issuers, and subjects are strictly prohibited from entering `Detection`, telemetry, logs, or errors.
- Decoded material exists transiently exclusively for structural JSON validation and is immediately discarded.
- Parsing errors (Base64/JSON) are silently caught and do not wrap raw source data into logs or errors.

## Negative Test Limitation
No malformed JWT test fixture exists in the automated suite because Antigravity is strictly prohibited from fabricating unauthorized malformed or cryptographic security fixtures.
