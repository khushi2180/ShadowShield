# Data Flow

The following describes the inspection request flow:

1. **Browser**: User enters a prompt intended for an AI service (e.g., ChatGPT).
2. **Extension**: Intercepts the request and forwards the content.
3. **Native Messaging**: Secures the transport between the extension and the local system agent.
4. **Agent**: Receives the `InspectionRequest`.
5. **Inspection**: The Core applies active detectors against the content.
6. **Policy**: Evaluates detections and calculates risk, generating a final action (`ALLOW`, `COACH`, `REDACT`, `BLOCK`).
7. **Browser**: The extension enforces the policy action.

## Transient Content Principle

Raw sensitive content must NOT enter telemetry or persistent logs by default. The `content` string inside an `InspectionRequest` is explicitly transient.
