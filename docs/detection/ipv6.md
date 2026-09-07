# IPv6 Detector

## Purpose
Detect IPv6 addresses in text.

## Authoritative Basis
- IP Structure: Standard IPv6 definitions.
- Fixtures: RFC 3849 documentation prefix.

## Candidate Discovery
Uses a candidate discovery regex (e.g., `(?i)(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}`) to identify IPv6-shaped text segments containing at least two colons. This process is intended to loosely identify candidates without improperly consuming surrounding brackets, parentheses, or trailing punctuation. The extraction bounds may evolve as additional maintainer-approved boundary fixtures become available.

## Validation Method
Structural validation using `std::net::Ipv6Addr::from_str`. This parser is fully authoritative for structural acceptance of IPv6 strings. It reliably validates both expanded and compressed zero notations (`::`). No network requests are made.

## Validation Level
**StructurallyValid**: The candidate parses perfectly into an IPv6 address structure via the standard library.

## Provisional Severity
**Medium**

## Known Limitations
Does not classify local vs global routing types. It relies on candidate discovery and may not capture every possible malformed textual representation beyond what has actually been explicitly tested and approved.

## False-Positive Considerations
MAC addresses are structurally rejected by the parser. Pure hex dumps with colons might match if they align exactly as a valid IPv6 string.

## Privacy Behavior
It does not log the detected IP address and never includes the raw string in the `Detection`.

## Approved Fixtures
- `2001:db8::1`
- `2001:db8:582:ae33::29`
