# Enforcement States

## AI Access vs DLP
ShadowShield evaluates **AI Access** first. If blocked/coached at the access layer, the prompt content is never transmitted to the Native Agent for DLP inspection.

## Submission States

- **ALLOW**: If the inspection returns Allow, ShadowShield resumes the submission exactly once via a scoped hash bypass. 
- **BLOCK**: Halts the submission. The content is preserved locally in the composer, and the UI displays a generic Blocked banner. The raw matched sensitive substring is NEVER echoed back or displayed in the UI.
- **COACH**: Halts the submission. The user sees a coaching banner and must explicitly choose "Cancel" (which aborts) or "Proceed" (which resumes the submission exactly once, skipping this inspection step).
- **REDACT**: Replaces the local composer text exclusively with the Native Agent's `sanitized_content`. It verifies that the browser successfully applied the `sanitized_content` before resuming the submission. If write-back validation fails, the action degrades safely into a **BLOCK** (fail closed).
- **DISCONNECTED**: If the Native Agent is unavailable, any attempted interception forces a **FAIL CLOSED** outcome to ensure zero unprotected data escapes.

## Stale-Content & Race Conditions
If the user modifies the composer content *during* an async inspection or UI state wait (e.g., Coach), ShadowShield relies on a local SHA-256 Web Crypto hash. The action (Allow/Proceed/Redact) will be discarded safely, restoring protection.
