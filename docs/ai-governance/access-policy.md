# AI Access Policy

The `AiAccessPolicy` evaluates an AI service's classification against an organizational access mode to produce an `AiAccessDecision`.

## Access Modes

### Discovery Mode
Provides visibility into Shadow AI usage without enforcing blocks based on service identity.
- **Approved**: Allow
- **Restricted**: Allow
- **Blocked**: Allow
- **Unknown**: Allow

*(Note: Data Protection / DLP policies still apply and may block sensitive content, even in Discovery mode).*

### Policy Mode
The standard operating mode for balanced security.
- **Approved**: Allow
- **Restricted**: AllowRestricted (May trigger stricter downstream DLP inspection)
- **Blocked**: Block
- **Unknown**: Coach (Prompts the user with guidance before proceeding)

### Strict Allowlist Mode
The enterprise zero-trust mode for AI usage.
- **Approved**: Allow
- **Restricted**: Block
- **Blocked**: Block
- **Unknown**: Block

## Data Independence
If an `AiAccessDecision` resolves to `Block`, the system safely terminates processing before inspecting the payload. However, an `Allow` decision strictly means "The service identity is permitted." It does **not** grant the content immunity from subsequent Data Policy enforcement.
