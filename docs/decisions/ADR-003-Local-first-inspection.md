# ADR-003: Local-first inspection

## Context
Sending sensitive user prompts to a cloud API for security inspection defeats the privacy purpose of the product.

## Decision
All sensitive content inspection must happen locally on the endpoint.

## Consequences
* Models and pattern matching must be performant enough to run locally without major battery/CPU drain.
* The product works offline for policy enforcement.
* Increased difficulty in deploying heavy ML models.

## Status
Accepted
