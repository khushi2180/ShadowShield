# ADR 004: Decoupling AI Access Policy from Data Protection

## Context
As ShadowShield expands to govern AI usage, we must decide how to evaluate whether a user can interact with an AI service. Should the risk of the AI service (e.g., its vendor's data retention policy) be mathematically blended with the risk of the data being sent (e.g., a credit card number) into a single unified risk score?

## Decision
We elected to strictly separate **AI Access Control** (Governance) from **Data Protection** (DLP).
- **AI Access** determines if the service identity is allowed based on organization classification (Approved, Restricted, Blocked, Unknown) and Access Mode (Discovery, Policy, Strict Allowlist).
- **Data Protection** evaluates the exact payload for sensitive patterns and executes policy (Allow, Coach, Redact, Block).

## Consequences
- **Architectural Clarity**: We avoid the conceptual impossibility of merging a "ChatGPT trust score of 80" with a "Credit Card risk score of 90."
- **Strict Allowlisting**: An organization can outright block "Unknown" shadow AI services without needing to inspect the payload.
- **No False Equivalency**: An Approved AI service (like a corporate-contracted tenant) cannot accidentally bypass DLP rules. Critical data will still be redacted or blocked regardless of the AI's Approved status.
- **Privacy Preservation**: If a service is blocked at the Access layer, the request is terminated before sensitive data is even parsed by the DLP engine.

## Status
Accepted
