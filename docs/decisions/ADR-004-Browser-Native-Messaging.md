# ADR-004: Browser Native Messaging

## Context
The browser extension needs a way to send prompts to the local agent for inspection.

## Decision
We will use Browser Native Messaging instead of a localhost HTTP server.

## Consequences
* Better security (avoids unauthenticated localhost REST API exposure).
* Lifecycle managed by the browser (can spawn the agent automatically).
* Tighter coupling to browser extension APIs.

## Status
Accepted
