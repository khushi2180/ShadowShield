# Browser-Agent Boundary

The boundary between the Browser Extension and the ShadowShield background agent represents the primary security trust boundary in the application.

## Principles
1. **The Extension is Untrusted**: The browser environment is notoriously malleable. Malicious sites or other extensions could potentially manipulate extension state. The agent treats all incoming JSON payloads as untrusted.
2. **Agent owns Policy Authority**: The agent does not trust the extension to assert organizational compliance (e.g. declaring ChatGPT as "Approved"). The extension provides the identity context (`chatgpt`), and the Agent enforces the policy against its own secure registry.
3. **Sensitive Payload Masking**: The extension passes textual prompts (`SensitiveText`) into the agent. The agent destroys the prompt internally. It does NOT echo the original prompt back in success logs, diagnostic payloads, or generic error messages.

## Cross-Platform Considerations
Browsers launch Native Messaging hosts using explicitly installed manifests mapping a secure extension ID to an absolute path for a local executable. ShadowShield provides template manifests (`com.shadowshield.agent.json`) for Windows and macOS environments.
