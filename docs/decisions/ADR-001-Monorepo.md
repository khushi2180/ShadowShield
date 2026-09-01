# ADR-001: Monorepo

## Context
ShadowShield contains multiple components spanning different languages (Rust, TypeScript, Python) and deployment targets (Agent, Tray, Extension, Backend).

## Decision
We will use a monorepo structure to house all components.

## Consequences
* Easier cross-component refactoring.
* Unified CI pipeline.
* Shared documentation.
* Requires disciplined boundary management to prevent entanglement.

## Status
Accepted
