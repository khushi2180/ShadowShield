# Slack Detector

## Authoritative Source
Modeled against official Slack authentication documentation.

## Supported Token Families
- `xoxb-` (slack_bot_token)
- `xoxp-` (slack_user_token)
- `xapp-` (slack_app_token)

## Detection Kinds
Identifies the correct kind via the canonical `xoxX-` prefix. `Category` is `Secret`.

## Validation Level & Severity
- **ValidationLevel**: `PatternMatch`
- **Severity**: `Critical`

## Candidate Assumptions & Formats
Slack documents that historical user tokens exhibit differing formats and lengths over time. ShadowShield structurally respects this format variation by enforcing the exact prefix bound by defensive limits (10 to 255 alphanumeric+hyphen characters), avoiding arbitrary one-size-fits-all length validation.

## Fixture State & Maturity
- **Maturity**: `Implemented`
- **FixtureVerified**: `false`
- **Enabled**: `false`
- **Limitations**: Positive credential detection is `BLOCKED_BY_FIXTURE`.

## No External Verification & Privacy
ShadowShield executes local-first structural checks. We absolutely DO NOT invoke `auth.test` or any Slack APIs. Raw tokens never enter `Detection` metadata or telemetry logging pipelines.
