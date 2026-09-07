# AI Governance Overview

ShadowShield implements a strict separation of concerns between **AI Access Control** and **Data Protection**.

## Separation of Concerns
- **AI Access Policy** answers: *May this AI service be used at all?*
- **Data Protection (DLP)** answers: *May this specific content be sent to that service?*

These two decisions are orthogonal. A service may be explicitly approved (e.g., a corporate ChatGPT instance), but critical data (like a plaintext secret key) will still be blocked by DLP. Conversely, an unknown shadow AI service might be permitted for discovery purposes, but sensitive data sent to it will still trigger redaction or blocking.

## Core Concepts
- **AiServiceId**: A strictly formatted identifier (e.g., `chatgpt`) used for machine-readable identity.
- **AiService**: The domain object representing a service's identity, vendor, and organization classification.
- **AiAccessMode**: Defines how the policy engine treats classifications (Discovery, Policy, StrictAllowlist).
- **AiAccessDecision**: The resulting action (`Allow`, `AllowRestricted`, `Coach`, `Block`).

## Extensibility
The registry currently operates in-memory for deterministic performance. Future iterations will support cloud synchronization to update classifications without deploying new binaries.
