# Deterministic Risk Model

## Objective
The ShadowShield risk model calculates an explainable, deterministic risk score for a given set of detections.

## Severity Base Scores
- **Low**: 10
- **Medium**: 30
- **High**: 60
- **Critical**: 90

## Validation Modifiers
Detectors assign structural validation levels, which incrementally boost the base severity.
- **PatternMatch**: +0
- **StructurallyValid**: +5
- **ChecksumValid**: +8
- **ContextCorrelated**: +10

*Example:* A `Medium` severity detection (30) that is `StructurallyValid` (+5) scores **35**.

## Aggregation Strategy (V1)
ShadowShield uses **MAXIMUM** individual detection score aggregation. We DO NOT sum scores. Three Medium PatternMatch detections (30 each) result in an aggregate score of 30, not 90. This strictly prevents low-severity spam from accidentally breaching the Critical threshold.

## Risk Thresholds
- **0 - 24**: `Low`
- **25 - 49**: `Medium`
- **50 - 79**: `High`
- **80 - 100**: `Critical`

Scores are hard-clamped at 100. Empty detections safely map to 0 / Low.

## Tie Handling
If multiple detections share the maximum score, we deterministically prefer the first detection sequentially.

## Explainability and Privacy
The resulting `RiskAssessment` records the score, level, and the index of the highest-scoring detection. It does **not** store raw text, preserving strict privacy.
