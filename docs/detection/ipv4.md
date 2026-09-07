# IPv4 Detector

## Purpose
Detect IPv4 addresses in text.

## Authoritative Basis
- IP Structure: Standard IPv4 definitions.
- Fixtures: RFC 5737 (documentation address blocks).

## Candidate Discovery
Uses a conservative bounding regex `\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b` to locate strings resembling IPv4 addresses without consuming surrounding punctuation.

## Validation Method
Structural validation using `std::net::Ipv4Addr::from_str`. This strictly enforces valid octet bounds (0-255). No network requests are made.

## Validation Level
**StructurallyValid**: The candidate string parses into a mathematically valid IPv4 address structure. 

## Provisional Severity
**Medium**

## Known Limitations
It does not currently classify IPs as public, private, loopback, multicast, or link-local. 

## False-Positive Considerations
Versioning schemes (e.g. `1.2.3.4`) may occasionally match if they conform precisely to 4 octets.

## Privacy Behavior
It does not log the detected IP address and never includes the raw string in the `Detection`.

## Approved Fixtures
- `192.0.2.53`
- `198.51.100.42`
- `203.0.113.10`
