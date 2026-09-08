# ADR 005: Native Messaging for Extension-Agent IPC

## Context
The ShadowShield browser extension must securely transmit multi-megabyte AI prompts to a background, offline Rust agent for DLP inspection and risk evaluation.

## Alternatives Evaluated
1. **Localhost HTTP REST API**: Prone to port conflicts, difficult to secure against arbitrary local processes executing requests, and complex to orchestrate startup/shutdown lifecycles alongside the browser.
2. **WebSocket Server**: Inherits the same security and port-conflict challenges as the HTTP REST server.
3. **WebAssembly (WASM)**: Embedding the Rust core directly into the extension via WASM ensures maximum offline privacy, but drastically limits our ability to interact with enterprise ML libraries, filesystem policies, or native OS auditing features in future phases.

## Decision
We elected to use **Chrome/Chromium Native Messaging** as the sole IPC mechanism.

## Consequences
- **Security**: The browser guarantees the identity of the extension, automatically launching the host process and tearing it down securely when the browser closes. Random local processes cannot easily spoof requests over the Native Messaging pipe.
- **Port Conflicts eliminated**: Native Messaging operates strictly over `stdio` file descriptors, eliminating the need to bind to a local TCP port.
- **Architecture**: Enforces a strict requirement that the Rust agent must carefully isolate its `stdout` output so that standard logging libraries do not corrupt the length-prefixed JSON protocol framing.

## Status
Accepted
