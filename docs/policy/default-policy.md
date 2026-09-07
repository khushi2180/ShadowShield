# Default Policy Engine Mapping

## Objective
The Policy Engine strictly consumes the `RiskLevel` produced by the Risk Engine and outputs a deterministic `PolicyAction`.

## V1 Mappings
- **Low** → `Allow` (Content passes silently)
- **Medium** → `Coach` (User receives an informative warning but may proceed in future interactive environments)
- **High** → `Redact` (Sanitized alternatives replace the sensitive text before downstream systems receive it)
- **Critical** → `Block` (Content is completely barred from submission)

## Architecture
The Policy Engine is purposefully separated from the Risk Engine. In the future, this separation allows organization-specific mappings (e.g. mapping `Medium` to `Block` for strict environments) to replace the default static mappings without rebuilding the risk calculations. Currently, V1 uses hardcoded internal defaults.
