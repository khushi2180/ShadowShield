# ShadowShield Desktop Tray — T4 Handoff & Operational Scope

## 1. Supported Tray Scope
`apps/desktop` is a **read-only status client** for `shadowshield-agent`:
- Displays `Online`, `Degraded`, `Stale`, and `Offline` based strictly on validated `Health` responses and local transport/liveness outcomes.
- Provides `"Show Status"` (focus/reveal status window) and `"Quit"` (clean exit) menu actions, with window-close persistence to the tray.
- Contains **no** protection-disable toggles, policy overrides, detector rules, risk scoring, or redaction logic.

## 2. Health-Only Status Authority & Unmonitored Integrations
- `Online`: `agent_running == true && inspection_engine_available == true` (with `protocol_version == 1`).
- `Degraded`: `agent_running == true && inspection_engine_available == false`.
- `Stale`: Health check exceeded `3,000 ms` deadline.
- `Offline`: Agent socket/token unavailable, handshake/auth failure, malformed/unknown IPC response, or `agent_running == false`.
- **Browser Protection** and **IDE Protection** always display `Unknown (unmonitored)`. Agent `Online` does not imply browser or IDE protection.

## 3. Platform Validation Gap (Windows Dev Host vs. macOS Target)
- R1 IPC uses macOS/Unix domain sockets (`~/Library/Application Support/ShadowShield/run/agent.sock`).
- On Windows, `UnsupportedPlatformTransport` is compiled via `#[cfg(not(unix))]`; live UDS communication with `shadowshield-agent` was **not** executed on Windows.
- Deterministic unit tests (using scripted/fault-injected `IpcTransport` and mocked Tauri `invoke`) verify framing, timeouts, token rotation, malformed responses, and lifecycle transitions.

## 4. Required macOS / Joint Integration Validation
Before release sign-off, run on macOS:
1. Live `shadowshield-agent` <-> `apps/desktop` UDS `Authenticate -> Hello -> Health` E2E verification.
2. Live daemon crash/restart and `auth.token` rotation recovery against `shadowshield-agent`.
3. Joint agent connection-saturation testing (`MAX_CONCURRENT_CLIENTS = 16`).
4. Live macOS menu-bar tray lifecycle (`ActivationPolicy::Accessory`, `Show Status`, window-close hide, `Quit`).
5. Full macOS bundling, Developer ID signing, and notarization (see `PACKAGING.md`).
