# ADR-010: Confidence Representation

## Context
Detectors return a confidence value representing the probability of a true positive. Raw floating-point numbers can be infinite, NaN, or out of bounds.

## Decision
We wrap a `u8` into a `Confidence` struct, ensuring at instantiation that it is bounded between `0` and `100` inclusive.

## Consequences
* Conceptually mapped to 0-100%.
* Invalid confidence initialization is rejected via `Result`.
* Simple, robust, and avoids the complexities of floating-point comparison and undefined behaviors.

## Status
Accepted
