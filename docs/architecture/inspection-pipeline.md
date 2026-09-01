# Inspection Pipeline

The inspection flow in ShadowShield follows a linear, stateless orchestration process implemented within the `shadowshield-core` crate.

```text
InspectionRequest
        │
        ▼
     Inspector
        │
        ▼
 Detector Registry
        │
        ▼
   Detections[]
        │
        ▼
    Risk Engine
        │
        ▼
   Policy Engine
        │
        ▼
 InspectionResult
```

- **Inspector**: Orchestrates the pipeline, validates requests, and enforces logging safety.
- **Detector Registry**: Contains isolated detectors that pattern-match or analyze text without external access.
- **Risk Engine**: Determines context-based risk (currently LOW).
- **Policy Engine**: Determines action based on risk (currently ALLOW).
