# Adapter Architecture

ShadowShield implements an `AiSiteAdapter` interface conceptually separating the underlying security logic (Policy, DLP) from the brittle realities of dynamic Single Page Applications (SPA).

## Philosophy

The extension is not permitted to:
- Make policy decisions.
- Classify AI tools.
- Declare the prompt content as sensitive or non-sensitive.
- Monkey-patch browser primitives (like `fetch`, `XMLHttpRequest`) broadly.

The browser simply handles **Composer Discovery**, **Submission Interception**, and **Enforcement UI (DOM Manipulation)**. The Heavy lifting occurs in the Rust Native Agent via Native Messaging.

## Re-entrancy Protection
Synthetic events used to resume submissions (Allow/Redact) are explicitly excluded from continuous interception using a localized, hashed one-shot bypass mechanism.
