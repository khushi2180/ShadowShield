# ADR-006: Dataset approval policy

## Context
Handling datasets, especially those containing potential PII or security fixtures, poses severe privacy, legal, and operational risks. AI agents automating development might indiscriminately fetch unverified data.

## Decision
No dataset may be autonomously generated, downloaded, scraped, or selected by any agent. All datasets require explicit maintainer approval and a strict manifest.

## Consequences
* Slows down initial ML development.
* Enforces strict provenance tracking.
* Eliminates the risk of hallucinated or legally tainted test fixtures.

## Status
Accepted
