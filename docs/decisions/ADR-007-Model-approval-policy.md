# ADR-007: Model approval policy

## Context
Integrating third-party ML models introduces supply chain risks, licensing ambiguity, and potential performance regressions.

## Decision
No model may be autonomously downloaded, selected, or introduced by any agent (no external LLM APIs). Model integration requires explicit maintainer approval.

## Consequences
* Prevents accidental dependencies on heavy or restricted ML models.
* Keeps the project focused on deterministic detectors first.
* Requires explicit architectural review before ML integration.

## Status
Accepted
