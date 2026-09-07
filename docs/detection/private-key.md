# Private Key Detector

## Purpose
Detect cryptographic private keys formatted in textual (PEM) encoding.

## RFC Basis
- RFC 7468 (Textual Encodings of PKIX, PKCS, and CMS Structures)
- RFC 8410 (EdDSA algorithms in X.509)

## Supported Labels
For Phase 1 V1, the detector supports exactly the following PEM labels:
- `PRIVATE KEY`
- `ENCRYPTED PRIVATE KEY`

## Candidate Discovery
Uses bounded regex parsing to find precise matching `BEGIN` and `END` labels encompassing a Base64-encoded body spanning multiple lines. The parser explicitly verifies that the BEGIN label matches the END label (e.g. `PRIVATE KEY` must end with `PRIVATE KEY`, not `ENCRYPTED PRIVATE KEY`).
To prevent pathological extraction and memory abuse, candidate extraction is bounded to 64KB.

## Structural Validation
The entire Base64 body is stripped of ASCII whitespace natively. Only RFC textual-encoding whitespace is ignored. If the body contains any other non-Base64 characters, `BASE64_STANDARD.decode` correctly fails, and the candidate is rejected. The decoded binary payload must also be non-empty.

## Validation Semantics
Passing this detector means the block passes ShadowShield's structural validation.

This detector validates ONLY:
- recognized RFC-style boundary
- matching BEGIN/END labels
- supported label
- Base64-decodable body
- non-empty decoded content

It does NOT prove:
- valid PKCS #8 ASN.1
- cryptographic correctness
- usable private key
- successful decryption
- key ownership

## Scope and Limitations
**Supported**:
- Base64-decodable PKCS #8 private keys explicitly labeled as `PRIVATE KEY` or `ENCRYPTED PRIVATE KEY`.

**Unsupported (Phase 1 V1)**:
- Algorithm-specific legacy keys (e.g., `RSA PRIVATE KEY`, `EC PRIVATE KEY`, `OPENSSH PRIVATE KEY`, `DSA PRIVATE KEY`).
- ASN.1 / DER semantic parsing of the decoded binary blob.
- Cryptographic validity assertions.
- Passphrase decryption.

## Encrypted Key Semantics
The detector identifies `ENCRYPTED PRIVATE KEY` correctly, but classifies it aggregately under the standard `private_key` DetectionKind. It does not attempt decryption, nor does it prompt for passwords.

## Validation Level
**StructurallyValid**: The candidate's `BEGIN` and `END` boundaries matched perfectly according to RFC 7468 and the enclosed body was successfully Base64 decoded. It is structurally valid within ShadowShield's definitions, but is NOT cryptographically validated.

## Privacy Behavior
- Raw textual private keys, decoded cryptographic binaries, algorithms, and key sizes are strictly excluded from `Detection`, telemetry, logs, or error emissions.
- Base64 parsing failures are silently caught and do not wrap raw body data.
- The normalized Base64 body is kept exclusively in transient memory for decoding and is never persisted.

## Negative Test Limitation
No malformed private key test fixture exists in the automated suite because Antigravity is strictly prohibited from fabricating unauthorized malformed or cryptographic security fixtures.
