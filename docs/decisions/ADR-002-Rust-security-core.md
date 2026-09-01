# ADR-002: Rust security core

## Context
The security inspection engine needs to be fast, safe, and deployable as a background agent across multiple operating systems with minimal overhead.

## Decision
We will write the core security engine, detectors, and agent daemon in Rust.

## Consequences
* High performance and memory safety.
* Easy cross-compilation.
* Strict typing for security boundaries.
* Steeper learning curve for contributors compared to Go or Python.

## Status
Accepted
