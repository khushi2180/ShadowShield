# ChatGPT Production DOM Findings
**Status:** `LIVE TEST PENDING`

*This document records findings from live production testing against `chatgpt.com`. It will be updated as maintainer testing progresses.*

---

### Composer Heuristic
*Pending Live Verification*

Expected to find `#prompt-textarea` or a single `contenteditable="true"` element within the `<main>` region.

### Send-Button Heuristic
*Pending Live Verification*

Expected to find `button[data-testid="send-button"]` near the composer.

### Keyboard Behavior
*Pending Live Verification*

Expected interception of unshifted `Enter` events on the composer. IME composition and modifier-key presses should safely bypass the interceptor.

### SPA Replacement
*Pending Live Verification*

Expected `MutationObserver` on `document.body` to correctly detect when the React application tears down the composer and mounts a new one during conversation navigation, triggering an automatic re-bind of interceptors.

### Resume Mechanism
*Pending Live Verification*

Expected the synchronous synthetic event dispatch (`dispatchSyntheticSubmission`) to successfully simulate the user's interrupted submission without triggering a recursive interception loop.

### UI Collision
*Pending Live Verification*

Expected the Shadow DOM isolated `EnforcementUi` to render cleanly without adopting global ChatGPT CSS variables, and without disrupting the ChatGPT flexbox layout.

### Native Messaging
*Pending Live Verification*

Expected the `com.shadowshield.agent` native messaging host to frame messages correctly over standard I/O and handle transient disconnections cleanly via Port state management.

### Observed Failures
*(None recorded yet. To be populated during live tests.)*

### Required Adapter Changes
*(None recorded yet. To be populated if heuristics require adjustments.)*
