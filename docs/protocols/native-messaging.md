# Native Messaging

ShadowShield uses standard Chrome/Chromium Native Messaging framing for secure communication between the browser extension and the background Rust agent.

## Framing
Each message sent and received consists of:
1. A **4-byte unsigned integer** (little-endian) representing the length of the upcoming payload.
2. The payload: a **UTF-8 encoded JSON string**.

The agent is strict. It immediately drops oversized messages (>10MB limit) and closes the connection to defend against untrusted allocations.

## Stdout Security Invariant
When the agent executes in Native Host Mode (`--native-host`), the `stdout` channel belongs **exclusively** to the Native Messaging protocol. Any extraneous debug output, logs, or panic traces written to `stdout` will irreversibly corrupt the framing logic for the browser extension.

All logs in Native Host Mode must be forcefully redirected to `stderr`.

## Extension Architecture
The Manifest V3 extension utilizes `chrome.runtime.connectNative` targeting `com.shadowshield.agent`. It negotiates over `stdio` maintaining a long-lived persistent port where feasible, gracefully recovering from `onDisconnect` events.

## Permissions
The extension requests only `nativeMessaging` permissions during this foundation phase to maintain the smallest attack surface possible.
