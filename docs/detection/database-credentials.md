# Database Credential Detector

## Authoritative Source
RFC 3986 (Uniform Resource Identifier) and vendor-specific database connection string formats.

## Supported Schemes
- `postgres`
- `postgresql`
- `mysql`
- `mongodb`
- `mongodb+srv`
- `redis`

## Architecture & Validation Level
- **Architecture**: A rough regex extracts connection URI candidates. These are then parsed strictly using the `url` crate. The detector asserts that the scheme is supported AND that an actual authentication password is embedded. A generic database connection string (e.g. `postgres://localhost/db`) without credentials is deliberately ignored.
- **ValidationLevel**: `StructurallyValid` (Achieved via formal URL parsing).
- **Severity**: `Critical`

## Dependency Decision
Added the `url = "2.5"` crate to `crates/detectors/Cargo.toml`. This is the mature, standard, non-networking Rust parser for URIs, which is far safer and more accurate than a giant regex for credential extraction.

## Fixture State & Maturity
- **Maturity**: `Implemented`
- **FixtureVerified**: `false`
- **Enabled**: `false`
- **Limitations**: Positive credential testing is `BLOCKED_BY_FIXTURE` since no maintainer-approved fake database URI is available. We absolutely will not generate synthetic credentials.

## Privacy & Redaction Capabilities
The detector operates entirely offline. It does not attempt a connection to the database. No username, password, hostname, database name, or connection string components are stored in the detection metadata. The `DetectionLocation` captures the entire string, enabling future safe redaction of the connection URI.
