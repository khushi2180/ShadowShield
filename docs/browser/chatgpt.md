# ChatGPT Adapter

This document details the ShadowShield integration with ChatGPT.

## Scope
- **Host Permission**: `https://chatgpt.com/*`
- **Supported Surfaces**: Primary Text Composer.

## Explicitly Unsupported Surfaces
This phase explicitly does NOT intercept or protect:
- File Uploads
- Image Uploads
- Voice Inputs
- Canvas or secondary editing panes
- Assistant Output responses (Output DLP deferred)

## Composer Discovery (Heuristics)
ShadowShield uses an ordered heuristic strategy to discover the ChatGPT composer:
1. `#prompt-textarea` with associated roles/semantics.
2. Fallback to `contenteditable="true"` elements within standard known region layouts (`main`, `form`).

These are **Implementation Heuristics**, NOT official or stable OpenAI APIs.

## SPA Handling
Because ChatGPT is a highly dynamic SPA, ShadowShield employs a `MutationObserver` on `document.body` with `{ childList: true, subtree: true }`. To prevent performance bottlenecks, observation reconciliation is debounced (approx 100ms) and ignores modifications if the current composer remains valid and attached to the DOM.
