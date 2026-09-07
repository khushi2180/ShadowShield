# Email Detector

## Purpose
A practical, conservative detector to find common employee email addresses.

## Authoritative Basis
- IANA reserved example domains policy for fixture safety.

## Candidate Discovery
Uses a bounded regex targeting `local-part@domain.tld`.

## Validation Method
Validates length (<= 254) and leverages the regex for basic structural constraints (alphanumeric, acceptable symbols, standard domain structure). No DNS queries or MX lookups are performed. No network requests are made.

## Validation Level
**PatternMatch**: Because we rely purely on a regex rather than a rigorous RFC 5322 parser constructing a typed domain object, we honestly classify this as a pattern match.

## Provisional Severity
**Medium**

## Known Limitations
It is not a complete RFC 5322 validator. It deliberately ignores extreme obscure cases (e.g. quoted strings with trailing backslashes) in favor of practical performance and lower false positives.

## False-Positive Considerations
Strings that look like emails but are actually internal network logins `user@server.local` might be captured depending on domain part regex constraints.

## Privacy Behavior
It does not log the detected email and never includes the raw string in the `Detection`.

## Approved Fixtures
- `alice@example.com`
- `security@example.org`
