# ShadowShield V2 — Module Ownership & Governance

This document establishes the code ownership, subsystem boundaries, and review policies for ShadowShield V2.

---

## 1. Workstream Owners

| Owner | Subsystem / Workstream | Primary Repositories & Directories | Responsibilities |
|---|---|---|---|
| **Krish** | **Rust Backend & Integration Coordination** | `apps/agent/`<br>`crates/core/`<br>`crates/detectors/`<br>`crates/protocol/`<br>`crates/ml-runtime/` | • Secure local IPC server & daemon lifecycle<br>• `Inspector`, deterministic risk, policy, redaction engines<br>• Shared protocol definition (`crates/protocol`)<br>• Chrome Native Messaging backward compatibility<br>• Cross-team integration coordination |
| **Khushi** | **VS Code Extension** | `apps/vscode/` | • VS Code extension lifecycle & UI<br>• Controlled prompt dispatch workflow<br>• Snapshot binding & buffer integrity<br>• Developer coaching & redaction UX |
| **Keshav** | **Desktop Tray UI** | `apps/desktop/` | • Desktop Tray menu & status indicators<br>• Agent liveness polling & health status rendering<br>• Alert notifications for DLP blocks & coaching<br>• Offline / Degraded state management |

---

## 2. Shared Files & Review Requirements

The following files and directories are **shared infrastructure**. No single owner may modify or merge changes to these paths without explicit sign-off from all impacted owners:

| Shared Path | Impacted Owners | Required Approvals |
|---|---|---|
| `crates/protocol/src/ipc.rs` | Krish, Khushi, Keshav | **Unanimous (Krish, Khushi, Keshav)** |
| `crates/protocol/src/lib.rs` | Krish, Khushi, Keshav | **Unanimous (Krish, Khushi, Keshav)** |
| `docs/v2/IPC_CONTRACT.md` | Krish, Khushi, Keshav | **Unanimous (Krish, Khushi, Keshav)** |
| `docs/v2/OWNERSHIP.md` | Krish, Khushi, Keshav | **Unanimous (Krish, Khushi, Keshav)** |
| `Cargo.toml` (Workspace root) | Krish | Krish review required |
| `pnpm-workspace.yaml` | Krish, Khushi, Keshav | Krish + requesting owner |

---

## 3. Rules of Engagement

1. **Protocol Immutability:** The IPC wire format defined in `docs/v2/IPC_CONTRACT.md` is frozen upon team sign-off. Any addition or alteration requires a formal RFC and approval from all three workstream leads.
2. **Fail-Closed Safety:** If an IPC client loses connection to the agent daemon, it must fail closed. No client may transmit prompt content directly to an AI destination in the event of an IPC failure.
3. **Privacy Invariant:** Client code (`apps/vscode`, `apps/desktop`) must strictly observe the transient content principle. Prompt content must never be logged, written to disk diagnostics, or transmitted to telemetry.
4. **Fixture Safety:** Only approved fixtures listed in `tests/fixtures/deterministic/manifest.json` may be used in tests. No team member may generate synthetic secrets or real API keys that could trigger GitHub Push Protection or leak credentials.
5. **V1 Regression Protection:** Changes in the Rust backend must preserve 100% of the V1 Chrome Native Messaging test suite and protocol behavior.
