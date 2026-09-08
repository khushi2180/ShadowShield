# Browser ↔ Agent Protocol

## Envelope
All messages use a versioned envelope design:
```json
{
  "protocol_version": 1,
  "request_id": "req-123",
  "type": "Inspect",
  "payload": { ... }
}
```

## Correlation
Requests generate deterministic `request_id` values which are returned untouched by the agent. Extensions maintain pending promise queues tied to these IDs.

## Message Types
1. **Hello**: Verifies protocol and agent version compatibility.
2. **Health**: Non-sensitive liveness check.
3. **EvaluateAiAccess**: Validates organizational AI classification using the agent as the sole security authority.
4. **Inspect**: Transports textual payloads for scanning. Returns only sanitized metadata.

## AI Access Authority
The extension is untrusted regarding security configurations. It may declare `"ai_service": "chatgpt"`, but it CANNOT declare `"classification": "Approved"`. Only the Agent's in-memory `AiServiceRegistry` can determine classification and policy enforcement decisions.

## Error Codes
Stable error codes prevent brittle matching:
- `unsupported_protocol`
- `malformed_message`
- `message_too_large`
- `invalid_request`
- `internal_error`
