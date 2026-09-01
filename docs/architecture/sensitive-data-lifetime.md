# Sensitive Data Lifetime

ShadowShield guarantees that sensitive input prompt data remains transient by default.

```text
Browser
   ↓
transient content
   ↓
Agent memory
   ↓
inspection
   ↓
decision
   ↓
content discarded
```

## Telemetry
Only privacy-preserving metadata (e.g., detection counts, risk levels, actions) is collected by default. Raw sensitive content does not enter telemetry.

## Logs
Any local logs emit strictly metadata. Raw content is explicitly excluded from internal logging and `Debug` implementations by design.

*Note: True secure memory zeroization is not yet implemented in Phase 1A.*
