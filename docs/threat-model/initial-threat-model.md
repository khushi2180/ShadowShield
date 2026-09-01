# Initial Threat Model

This document outlines initial considerations for ShadowShield. **Note: These risks are not yet solved in Phase 0.**

* **Accidental sensitive-data submission**: The primary threat ShadowShield mitigates (e.g., pasting keys to ChatGPT).
* **Malicious browser pages**: Pages attempting to bypass or exploit the extension.
* **Malicious extension communication**: Rogue extensions attempting to communicate with the Agent.
* **Local IPC abuse**: Malicious local processes attempting to query the agent or inject false detections.
* **Telemetry leakage**: Accidental inclusion of PII or secrets in telemetry.
* **Sensitive logs**: Writing raw prompt content to local disk logs.
* **Compromised agent**: An attacker gaining control of the agent executable.
* **Bypass attempts**: Obfuscating prompts to avoid detection.
