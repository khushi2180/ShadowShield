# ADR 003: Deterministic V1 Risk Engine

## Context
ShadowShield detects varying forms of sensitive data with different granularities. A 10-digit number could be a generic identifier or an official Aadhaar depending on structural checksum checks. We need to aggregate raw detections into a normalized Risk Assessment score to determine final policy (Allow, Coach, Redact, Block).

## Decision
We elected to build a completely deterministic rule-based V1 Risk Engine leveraging explicit severity base scores and validation modifiers, clamped to a 0-100 range. We strictly use **MAXIMUM** aggregation instead of summing.

## Consequences
- **Explainability**: Every score can be directly traced back to exactly one primary detection and its fixed configuration (e.g. Medium Severity (30) + Structurally Valid (+5) = 35).
- **No Spam Inflation**: Finding the same email address 15 times yields a score of 30, not an inflated score of 450 that falsely triggers a "Critical" blockade.
- **Zero Hallucination**: No ML model or stochastic classifier can silently invent hidden risk multipliers based on irrelevant context words.
- **Maintainability**: Security engineers can audit a simple static table of mappings without understanding complex vector relationships.

## Status
Accepted
