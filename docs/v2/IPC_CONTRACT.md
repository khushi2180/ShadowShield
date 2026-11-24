# ShadowShield V2 — Unified IPC Contract

**Status:** Proposed — Awaiting Three-Member Sign-Off (Krish, Khushi, Keshav)  
**Protocol Version:** `1`  
**Base Implementation:** Crate `shadowshield-protocol` (`crates/protocol/src/ipc.rs` and `crates/protocol/src/lib.rs`)

---

## 1. Overview & Trust Architecture

ShadowShield V2 extends endpoint AI Data Loss Prevention from the Chrome browser to local developer and desktop workflows. All inspection, risk scoring, and policy decisions are executed locally by the headless Rust agent daemon (`shadowshield-agent`).

### 1.1 Components & Roles
- **Rust Agent Daemon (`apps/agent`)** — *Owner: Krish*: Owns the inspection engine (`Inspector`), detection rules, risk calculation, policy enforcement authority, and the secure local IPC server.
- **VS Code Extension (`apps/vscode`)** — *Owner: Khushi*: Provides a controlled prompt submission workflow for developers, intercepting developer-initiated prompts before dispatch to AI destinations.
- **Desktop Tray UI (`apps/desktop`)** — *Owner: Keshav*: Provides system-wide agent liveness monitoring, inspection engine status display, and user-facing notifications.
- **Chrome Extension Native Host (`shadowshield-native-host`)** — *Owner: Krish*: Existing V1 Chrome browser integration running over standard I/O pipes (`stdio`), completely unchanged.

### 1.2 Trust Boundary & Threat Model

```
+-----------------------------------------------------------------------------+
| USER SESSION (UID: 501)                                                     |
|                                                                             |
|  +--------------------+  +--------------------+                             |
|  | VS Code Extension  |  | Desktop Tray UI    |                             |
|  | (apps/vscode)      |  | (apps/desktop)     |                             |
|  +---------+----------+  +---------+----------+                             |
|            |                       |                                        |
|            | Reads auth.token      | Reads auth.token                       |
|            | (mode 0600)           | (mode 0600)                            |
|            +-----------+-----------+                                        |
|                        |                                                    |
|                        v Unix Domain Socket (UDS)                           |
|       ~/Library/Application Support/ShadowShield/run/agent.sock             |
|       (Directory: 0700 | Socket: 0600 | Peer EUID Verified)                 |
|                        |                                                    |
|  +---------------------v-------------------------------------------------+  |
|  | ShadowShield Agent Daemon (apps/agent)                                |  |
|  |                                                                       |  |
|  | - Single-Instance Lock: agent.lock (flock)                            |  |
|  | - Ephemeral Token: auth.token (32-byte CSPRNG hex)                    |  |
|  | - Inspection Engine: Inspector (deterministic detectors, risk, policy)|  |
|  +-----------------------------------------------------------------------+  |
|                                                                             |
|  --- UNTRUSTED BOUNDARY ---                                                 |
|  Other OS Users / Daemons (UID != 501): Blocked by DAC (0700) & getpeereid |
|  Network / Remote Webpages: No TCP port bound; completely unaddressable     |
+-----------------------------------------------------------------------------+
```

#### Security Guarantees & Explicit Limitations
1. **Multi-User Isolation (Enforced):** Unix file permissions (`0700` directory, `0600` socket) combined with kernel-level peer credential validation (`getpeereid`) prevent any process running under a different user or unprivileged daemon (e.g. `nobody`) from connecting to or reading the socket.
2. **Network Evasion & CSRF Immunity (Enforced):** Because no TCP localhost port is opened, remote websites and browser tabs cannot probe, scan, or execute cross-site requests (CSRF / DNS-rebinding) against the agent.
3. **Same-User Client Authorization (MVP Model):**
   - The agent requires the client to present an ephemeral 256-bit random session token stored in `auth.token` (permissions `0600`).
   - *Limitation:* Any process running under the **same user account** with filesystem read access can read `auth.token` and connect to the socket.
   - *No Binary Attestation:* The MVP **does not** perform cryptographic code signing verification of the connecting client binary (e.g. Apple Designated Requirement checks). True binary identity verification is deferred to post-MVP hardening.

---

## 2. Transport & Socket Security Specification (macOS)

### 2.1 File System Paths & Permissions

| Resource | Path | Permissions | Owner | Description |
|---|---|---|---|---|
| **Runtime Directory** | `~/Library/Application Support/ShadowShield/run/` | `0700` (`drwx------`) | Current User (`getuid()`) | Private runtime directory. Symlinks strictly prohibited. |
| **Lock File** | `.../run/agent.lock` | `0600` (`-rw-------`) | Current User (`getuid()`) | Advisory single-instance lock via `flock(LOCK_EX \| LOCK_NB)`. |
| **IPC Socket** | `.../run/agent.sock` | `0600` (`srw-------`) | Current User (`getuid()`) | Unix Domain Socket (`AF_UNIX`, `SOCK_STREAM`). |
| **Auth Token** | `.../run/auth.token` | `0600` (`-rw-------`) | Current User (`getuid()`) | Ephemeral 32-byte CSPRNG token (64 hex characters). |

### 2.2 Symlink Defense & Runtime Safety
To prevent symlink attacks and race conditions:
1. **Component-by-Component Verification:** Every path component from `$HOME` down to `run` is inspected via `lstat` (`std::fs::symlink_metadata`). If any component is a symbolic link, daemon startup halts immediately with a fatal security error.
2. **Avoiding Multithreaded `umask` Mutations:** Process-wide `umask` modifications in multithreaded programs create data races across threads. The daemon **does not** mutate `umask` during runtime. Instead:
   - Directories are created using `std::os::unix::fs::DirBuilderExt::mode(0o700)`.
   - Files (`agent.lock`, `auth.token`) are opened using `std::os::unix::fs::OpenOptionsExt::mode(0o600)`.
   - Socket permissions are explicitly set via `std::fs::set_permissions(path, Permissions::from_mode(0o600))` immediately upon binding, or single-threaded `umask(0o177)` is applied strictly before any worker threads are initialized.

### 2.3 Single-Instance Enforcement & Stale Socket Recovery
The daemon startup follows a strict, non-racy state machine:
1. **Directory Setup:** Creates or validates `~/Library/Application Support/ShadowShield/run/` with `0700` mode.
2. **Atomic Lock Acquisition:** Opens `agent.lock` (`O_CREAT | O_RDWR`, mode `0600`) and calls `flock(fd, LOCK_EX | LOCK_NB)`.
   - *Conflict:* If `flock` returns `EWOULDBLOCK`, another daemon is running. The process aborts immediately. `agent.sock` is left untouched.
   - *Success:* Holding the lock guarantees exclusive ownership of the runtime directory.
3. **Stale Socket Probe & Unlink:**
   - With `agent.lock` held, if `agent.sock` exists, the daemon tests connectivity via `UnixStream::connect(&socket_path)`.
   - If `ECONNREFUSED` or `ENOENT`, the socket is stale from an ungraceful crash. The daemon unlinks `agent.sock`.
4. **Socket Bind:** The daemon binds `UnixListener` to `agent.sock` and verifies mode `0600`.
5. **Token Generation:** The daemon generates 32 cryptographically secure random bytes (`OsRng`), hex-encodes them (64 ASCII hex characters), writes to `auth.token.tmp`, calls `fsync`, and atomically renames to `auth.token` with mode `0600`.
6. **Clean Shutdown:** Upon receiving `SIGINT` or `SIGTERM`:
   - Daemon stops accepting new connections.
   - Active streams are given a 2-second drain window.
   - `auth.token` and `agent.sock` are unlinked.
   - `agent.lock` is released and closed.

---

## 3. Socket-Only Authentication Protocol

To preserve existing V1 Chrome Native Messaging compatibility and keep `HelloRequest` unchanged in `crates/protocol/src/ipc.rs`, authentication on Unix Domain Sockets occurs in a **dedicated pre-Hello authentication phase**.

```
Client                                                  Rust Agent Daemon
  |                                                             |
  | ----------- 1. OS Connect (Unix Domain Socket) -----------> |
  |                                                             | [Kernel Peer Credential Check]
  |                                                             | (getpeereid: EUID == daemon EUID)
  |                                                             |
  | --- 2. Length-Prefixed Authenticate Frame ----------------> |
  |      { type: "Authenticate", payload: { token: "..." } }    |
  |                                                             | [Constant-Time Token Validation]
  | <--- 3. Length-Prefixed AuthenticateResponse -------------- |
  |      { type: "AuthenticateResponse", payload: { ... } }     |
  |                                                             | [Connection Marked Authenticated]
  |                                                             |
  | --- 4. Length-Prefixed Hello Frame -----------------------> |
  |      { type: "Hello", payload: { extension_version, ... } } |
  |                                                             | [Standard Protocol Handler]
  | <--- 5. Length-Prefixed HelloResponse --------------------- |
  |                                                             |
  | --- 6. Subsequent Frames (Health, Inspect, etc.) ---------> |
```

### 3.1 Authentication Framing & Envelope

The authentication handshake uses the standard ShadowShield length-prefixed frame (4-byte LE length + JSON string) and standard `IpcRequest` / `IpcResponse` envelopes.

#### Authenticate Request (`type: "Authenticate"`)
Sent by the client immediately after socket connection:
```json
{
  "protocol_version": 1,
  "request_id": "auth-001",
  "type": "Authenticate",
  "payload": {
    "token": "64_character_hex_encoded_token_from_auth_token_file"
  }
}
```

#### Authenticate Response (`type: "AuthenticateResponse"`)
Emitted by the agent upon successful verification:
```json
{
  "protocol_version": 1,
  "request_id": "auth-001",
  "type": "AuthenticateResponse",
  "payload": {
    "authenticated": true
  }
}
```

### 3.2 Authentication Rules & Error Handling
1. **Kernel Peer EUID Check:** On `listener.accept()`, the daemon executes `getpeereid(fd, &euid, &egid)`. If `euid != libc::geteuid()`, the connection is dropped immediately without reading or writing data.
2. **Pre-Hello Enforcement:** The first message received on a newly accepted Unix Domain Socket **must** be `Authenticate`. If a client attempts to send `Hello`, `Inspect`, or any other message before authenticating, the agent immediately emits an `IpcErrorResponse` (`code: "unauthorized"`, `message: "Authentication required before protocol interaction"`) and terminates the stream.
3. **Constant-Time Comparison:** The candidate token string is validated against the active daemon token using constant-time byte comparison (`subtle::ConstantTimeEq` or manual non-short-circuiting XOR loop) to prevent timing side-channel attacks.
4. **Failure Behavior:** If the token does not match, the agent returns:
   ```json
   {
     "protocol_version": 1,
     "request_id": "auth-001",
     "type": "Error",
     "payload": {
       "code": "unauthorized",
       "message": "Invalid authentication token"
     }
   }
   ```
   The socket is flushed and immediately closed (`shutdown(Both)`).
5. **Token Rotation & Daemon Restart:**
   - The token is ephemeral and bound to the process lifetime of the daemon.
   - When the daemon restarts, a new `auth.token` is generated.
   - Upon connection loss or restart, clients **must re-read `auth.token` from disk** before attempting to re-authenticate.
6. **V1 Chrome Native Messaging Invariant:** Chrome Native Messaging operates over `stdio` pipes launched directly by the browser. It does not use sockets, does not read `auth.token`, and does not execute the `Authenticate` frame. It connects directly to `protocol_handler::run_host_mode()` starting with `Hello`.

---

## 4. Framing, Limits & Concurrency

### 4.1 Length-Prefixed Streaming Layout
```
+------------------------------------+---------------------------------------+
|  Length: 4 bytes (u32, little-end) |  Payload: Length bytes of UTF-8 JSON  |
+------------------------------------+---------------------------------------+
```
- **Encoding:** 4-byte unsigned integer, Little-Endian (`u32::to_le_bytes` / `u32::from_le_bytes`).
- **Maximum Frame Length:** `10,485,760` bytes (10 MiB).
- **Header Guard Invariant:** Receivers read the 4-byte header first. If `length > 10,485,760`, the frame must be rejected **immediately** without allocating memory, emitting `message_too_large` error and closing the connection.
- **Stream Fragmentation:** Readers and writers must handle partial reads and partial writes. Receivers buffer incoming chunks until the 4-byte header is fulfilled, then accumulate until `length` payload bytes are received before passing to `serde_json::from_str`.

### 4.2 Timeouts & Cancellation Semantics

| Timeout Type | Duration | Initiator | Scope & Semantics | Action on Expiry |
|---|---|---|---|---|
| **Handshake Timeout** | `5,000 ms` | Agent Listener | Accepted stream until both `Authenticate` and `Hello` succeed | Daemon forcibly closes socket (`shutdown(Both)`). |
| **Server Processing Deadline** | `8,000 ms` | Agent Dispatcher | Max duration of synchronous inspection computation | Worker detects socket disconnect on response write (`BrokenPipe`) and discards result. |
| **Client Request Timeout** | `10,000 ms` | VS Code / Tray | Request write until response frame read | Client rejects pending Promise, removes `request_id` from map, blocks submission. |
| **Tray Health Timeout** | `3,000 ms` | Desktop Tray | Periodic health poll request | Tray marks agent state as `Unknown / Stale`. |
| **Idle Stream Timeout** | `300,000 ms` (5 min) | Agent Handler | Period of client inactivity on idle socket | Daemon gracefully closes idle connection. |

#### Cancellation & Worker Operation Semantics
- In synchronous Rust (`crates/core::Inspector::inspect`), deterministic regex and pattern scanning execute synchronously on worker threads.
- Rust does not support arbitrary preemptive thread termination (which risks resource leaks and mutex poisoning).
- Deterministic detectors operate in bounded linear time ($O(N)$ with strict regex constraints and a 10 MB payload ceiling); empirical processing latencies will be benchmarked and recorded under formal load during integration testing. The 8-second server deadline does not automatically terminate synchronous Rust inspection in-flight.
- **Explicit Cancellation Rule:** If a client request times out at 10s and closes the connection, the daemon worker finishes its bounded inspection computation, attempts to write the response back to the socket, detects stream closure (`BrokenPipe` / `EPIPE`), and safely drops the response without blocking or leaking resources.
- **Late Response Handling:** If a response arrives at a client after its 10-second timeout has expired, the client observes that `request_id` is no longer in its pending queue, logs a debug note, and safely discards the late frame.

### 4.3 Concurrency & Resource Limits
- **Max Concurrent Clients:** `16` connections (sufficient for VS Code, Desktop Tray, Extension bridge, and CLI). New connections beyond 16 are rejected.
- **Max Ingress Pipeline Depth:** `8` concurrent pending requests per stream. Excess requests receive `internal_error` (backpressure).
- **Thread Safety:** `Inspector` is immutable (`&self`, `Send + Sync`), wrapped in `Arc<Inspector>`, shared cleanly across worker threads.

---

## 5. Verified Protocol Serialization (Source-Checked)

Every field name, enum variant, and data type below is verified against `crates/protocol/src/ipc.rs` and `crates/protocol/src/lib.rs`.

### 5.1 Envelopes

#### Request Envelope (`IpcRequest`)
```json
{
  "protocol_version": 1,
  "request_id": "req-1728691200000-001",
  "type": "Inspect",
  "payload": { ... }
}
```

#### Response Envelope (`IpcResponse`)
```json
{
  "protocol_version": 1,
  "request_id": "req-1728691200000-001",
  "type": "InspectResponse",
  "payload": { ... }
}
```

#### Error Envelope (`IpcErrorResponse`)
```json
{
  "protocol_version": 1,
  "request_id": "req-1728691200000-001",
  "type": "Error",
  "payload": {
    "code": "invalid_request",
    "message": "AiServiceId contains invalid characters"
  }
}
```

---

### 5.2 Message Catalog

#### 1. Hello (`HelloRequest` -> `HelloResponse`)
Negotiates protocol compatibility.
- **Request Payload (`HelloRequest`):**
  ```json
  {
    "extension_version": "0.1.0",
    "protocol_version": 1
  }
  ```
  *(Verified: Field is `extension_version: String`, `protocol_version: u32`).*
- **Response Payload (`HelloResponse`):**
  ```json
  {
    "agent_version": "0.1.0-dev",
    "protocol_version": 1,
    "compatible": true
  }
  ```

#### 2. Health (`HealthRequest` -> `HealthResponse`)
Liveness check.
- **Request Payload (`HealthRequest`):**
  ```json
  {}
  ```
- **Response Payload (`HealthResponse`):**
  ```json
  {
    "agent_running": true,
    "inspection_engine_available": true,
    "protocol_version": 1
  }
  ```
  *(Verified: Contains strictly these three fields. No unverified telemetry fields).*

#### 3. Evaluate AI Access (`EvaluateAiAccessRequest` -> `EvaluateAiAccessResponse`)
Evaluates service classification against organization policy.
- **Request Payload (`EvaluateAiAccessRequest`):**
  ```json
  {
    "service_id": "chatgpt",
    "mode": "Policy"
  }
  ```
  *(Verified Grammar: `service_id` must match `^[a-z][a-z0-9_]*$`).*  
  *(Verified Modes: `"Discovery"`, `"Policy"`, `"StrictAllowlist"`).*
- **Response Payload (`EvaluateAiAccessResponse`):**
  ```json
  {
    "service_id": "chatgpt",
    "classification": "Approved",
    "mode": "Policy",
    "decision": "Allow",
    "reason": "ApprovedService"
  }
  ```
  *(Verified Classifications: `"Approved"`, `"Restricted"`, `"Blocked"`, `"Unknown"`).*  
  *(Verified Decisions: `"Allow"`, `"AllowRestricted"`, `"Coach"`, `"Block"`).*  
  *(Verified Reasons: `"ApprovedService"`, `"RestrictedService"`, `"BlockedService"`, `"UnknownService"`).*

#### 4. Inspect (`InspectRequest` -> `InspectResponse`)
Runs DLP detection, risk scoring, and redaction.
- **Request Payload (`InspectRequest`):**
  ```json
  {
    "source": "VSCode",
    "ai_service": "chatgpt",
    "content": "Please explain the difference between TCP and Unix Domain Sockets.",
    "timestamp": 1728691200000
  }
  ```
  *(Verified Fields: `source: String`, `ai_service: String`, `content: String`, `timestamp: u64`).*

- **Response Payload (`InspectResponse` — Clean Input):**
  ```json
  {
    "detections_count": 0,
    "detections": [],
    "risk_assessment": {
      "score": 0,
      "level": "Low",
      "primary_detection_index": null
    },
    "action": "Allow",
    "sanitized_content": null,
    "processing_duration_ms": 1
  }
  ```

- **Response Payload (`InspectResponse` — Neutral Fixture Detection):**
  *(Example using approved neutral fixture `pii.ipv4.doc.1` `"192.0.2.53"`):*
  ```json
  {
    "detections_count": 1,
    "detections": [
      {
        "category": "Pii",
        "kind": "ipv4_address",
        "detector_id": "pii.network.ipv4",
        "confidence": 100,
        "validation": "StructurallyValid",
        "location": {
          "start_byte": 10,
          "end_byte": 22
        },
        "severity": "Low"
      }
    ],
    "risk_assessment": {
      "score": 15,
      "level": "Low",
      "primary_detection_index": 0
    },
    "action": "Allow",
    "sanitized_content": null,
    "processing_duration_ms": 2
  }
  ```
  *(Verified Detection Fields: `category: DetectionCategory`, `kind: DetectionKind`, `detector_id: DetectorId`, `confidence: Confidence`, `validation: ValidationLevel`, `location: Option<DetectionLocation>`, `severity: Severity`).*

---

## 6. Canonical Error Code Catalog

| Error Code | Meaning | Retry Allowed? | Reconnection Required? | Block Current Submission? | Display to User? |
|---|---|---|---|---|---|
| `unauthorized` | Token invalid, missing, or peer EUID mismatch | No | Yes (re-read token) | **Yes** | "ShadowShield authentication failed. Please restart the desktop agent." |
| `unsupported_protocol` | Client `protocol_version` does not match Agent | No | No | **Yes** | "ShadowShield protocol mismatch. Please update your client." |
| `malformed_message` | Payload does not conform to JSON struct schema | No | No | **Yes** | "Internal ShadowShield payload format error." |
| `message_too_large` | Frame size exceeds 10 MiB limit | No | No | **Yes** | "Prompt exceeds maximum allowed size (10 MB)." |
| `invalid_request` | Empty request ID or invalid `AiServiceId` characters | No | No | **Yes** | "Invalid inspection parameters specified." |
| `handshake_timeout` | Handshake did not complete within 5,000 ms | Yes (once) | Yes | **Yes** | "Agent handshake timed out." |
| `request_timeout` | Inspection processing took longer than 10,000 ms | Yes (once) | No | **Yes** | "Inspection request timed out. Submission blocked." |
| `internal_error` | Internal failure within agent inspection pipeline | Yes (once) | No | **Yes** | "ShadowShield inspection engine encountered an internal error." |

**Fail-Closed Rule:** Automatic prompt submission following any IPC failure or timeout is strictly prohibited.

---

## 7. VS Code Controlled AI Dispatch (Khushi)

Because VS Code extensions run in an isolated extension host without capabilities to monkey-patch or intercept third-party extension sockets, ShadowShield V2 implements a **Controlled Prompt Workflow** targeting the **VS Code Language Model API**.

### 7.1 Dispatch Target Evaluation
1. **API Selection:** `vscode.lm` (VS Code Language Model API, finalized in VS Code `1.90.0`).
2. **Minimum VS Code Version:** Engine `^1.90.0` in `package.json`.
3. **Model Provider Prerequisites:** Requires GitHub Copilot (`github.copilot` and `github.copilot-chat`) installed and an active authenticated Copilot subscription.
4. **User Consent:** On first invocation, VS Code prompts the user: *"Allow extension 'ShadowShield' to use the Language Model API?"*. If denied, dispatch aborts.
5. **Provider to `AiServiceId` Mapping:**
   - In `vscode.lm`, selecting `{ vendor: 'copilot' }` yields chat models with vendor `'copilot'`.
   - The extension maps vendor `'copilot'` strictly to `AiServiceId::new("github_copilot")`.
   - *Grammar Invariant:* The name is `github_copilot` (snake_case), adhering to `AiServiceId` validation.
   - *Governance Invariant:* `github_copilot` is **not** automatically classified as `Approved`. It evaluates against the agent's in-memory registry (defaulting to `UnknownService` -> `Coach` in Policy mode).

### 7.2 Controlled Prompt Composer & Snapshot Binding
1. **Invocation:** Developer enters prompt in ShadowShield Prompt Composer and optionally selects active editor code.
2. **Immutable Snapshot:** The extension captures an immutable in-memory snapshot string:
   ```typescript
   const promptSnapshot = composerInput + (selectedCode ? "\n" + selectedCode : "");
   const contentHash = crypto.createHash('sha256').update(promptSnapshot, 'utf8').digest('hex');
   ```
3. **Dispatch Ticket Lifecycle:**
   An ephemeral ticket is initialized:
   ```typescript
   interface DispatchTicket {
     id: string;
     contentHash: string;
     targetService: string; // "github_copilot"
     state: 'PENDING' | 'AUTHORIZED' | 'DISPATCHING' | 'CONSUMED' | 'INVALIDATED';
     authorizedContent?: string;
   }
   ```
4. **Pre-Flight Governance & Inspection:**
   - Client sends `EvaluateAiAccess` (`service_id: "github_copilot"`, `mode: "Policy"`). If blocked, abort.
   - Client sends `Inspect` (`ai_service: "github_copilot"`, `content: promptSnapshot`).
5. **Enforcement & Binding:**
   - `action == "Allow"`: `ticket.authorizedContent = promptSnapshot`, `ticket.state = 'AUTHORIZED'`.
   - `action == "Redact"`: `ticket.authorizedContent = response.sanitized_content`, `ticket.state = 'AUTHORIZED'`.
   - `action == "Block"`: `ticket.state = 'INVALIDATED'`, dispatch aborted.
   - `action == "Coach"`: Coaching dialog displayed. If user cancels, `ticket.state = 'INVALIDATED'`.
6. **Exactly-Once Application-Level Dispatch:**
   - Before calling `model.sendRequest()`, ticket state transitions atomically from `AUTHORIZED` to `DISPATCHING`. Any concurrent attempt detects `DISPATCHING` or `CONSUMED` and rejects.
   - Only `ticket.authorizedContent` is transmitted to `model.sendRequest()`.
   - If editor contents change before dispatch, the ticket hash is checked; mismatch triggers immediate invalidation.
   - Upon completion or failure of `model.sendRequest()`, ticket transitions to `CONSUMED`.

---

## 8. Desktop Tray Health & Status Model (Keshav)

The initial Desktop Tray UI reflects agent readiness using strictly verified fields from `HealthResponse`.

### 8.1 State Derivation Rules
Polling interval: 5 seconds via `HealthRequest`.

1. **Online / Ready:**
   - UDS connection established, `Authenticate` and `Hello` completed.
   - `HealthResponse` received: `agent_running: true` and `inspection_engine_available: true`.
   - Tray displays: **ShadowShield Active (Core Ready)**.
2. **Offline:**
   - Socket connection refused (`ECONNREFUSED`) or socket file absent.
   - Tray displays: **ShadowShield Offline (Agent Not Running)**.
3. **Unknown / Stale:**
   - Connection established, but `Health` request exceeds 3,000 ms timeout.
   - Tray displays: **Agent Status Unknown / Unresponsive**.
4. **Degraded:**
   - `agent_running: true`, but `inspection_engine_available: false`.
   - Tray displays: **Inspection Engine Degraded**.
5. **Protection Scope Indicators:**
   - **Browser Protection:** Must be displayed as `Unknown (unmonitored)`.
   - **IDE Protection:** Must be displayed as `Unknown (unmonitored)`.
   - *Rule:* The Tray UI **must not** display green checkmarks or "Active" labels for IDE or Browser protection until an approved bi-directional telemetry aggregation protocol is introduced.
6. **No Disable Protection Switch:** The initial Desktop Tray UI must not implement a 'Disable Protection' toggle or switch; DLP inspection remains continuously active and fail-closed whenever the agent is running.

---

## 9. Fixture & Privacy Rules

1. **No Real Secrets / No Synthetic Keys:** Tests and documentation must never include real tokens, credentials, or realistic synthetic API keys that could trigger GitHub Push Protection.
2. **Approved Fixtures Only:** When testing detection, use exclusively approved fixtures from `tests/fixtures/deterministic/manifest.json` (e.g. `pii.ipv4.doc.1` `"192.0.2.53"`).
3. **Transient Content Invariant:** Prompt contents, authentication tokens, and raw socket payloads must never be written to persistent log files, console diagnostics, or telemetry streams.
