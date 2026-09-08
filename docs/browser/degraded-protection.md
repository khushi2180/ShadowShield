# Degraded Protection

A highly dynamic SPA interface means that ShadowShield might identify it is operating on `chatgpt.com`, but fail to hook the primary composer.

## State: Degraded
If the adapter successfully boots on the protected domain but cannot bind interception listeners to the composer, it shifts to `Degraded`.

- **UI**: A persistent (but non-obtrusive) warning banner states protection could not be established.
- **Behavior**: It avoids repeatedly spamming the UI with re-discovery failures. It will NOT report the site as `Protected`. 
- **Cause**: Typical causes are upstream ChatGPT DOM redesigns breaking implementation heuristics.
