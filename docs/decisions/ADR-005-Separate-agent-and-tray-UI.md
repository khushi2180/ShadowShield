# ADR-005: Separate agent and tray UI

## Context
The system needs to run continuously to protect the user, but the UI is only occasionally needed for configuration or alerts.

## Decision
The core agent will be a headless daemon/service, completely separated from the Tray UI process.

## Consequences
* Enhanced stability (UI crashes do not bring down protection).
* Lower baseline memory footprint.
* Requires a secure IPC mechanism between the Tray UI and the Agent.

## Status
Accepted
