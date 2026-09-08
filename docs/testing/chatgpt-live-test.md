# ShadowShield — ChatGPT Live Integration Manual Test Checklist

This document details the exact manual steps to run a true production test of ShadowShield's ChatGPT protection on macOS + Chrome.

**Target**: `https://chatgpt.com/` (Google Chrome on macOS)

> [!WARNING]  
> **Do not use your real personal information, credit cards, passwords, or company secrets for these tests.** Use only approved safe fixtures. Do not record raw fixture values in screenshots.

---

## Preparation Phase

### 1. Build the Agent
Build the agent binary in development mode. From the repository root, run:
```bash
cargo build --workspace
```
Verify the binary exists at `target/debug/shadowshield-agent`.

### 2. Build the Extension
Build the browser extension components. From the `apps/extension` directory, run:
```bash
pnpm install
pnpm build
```

### 3. Load Unpacked Extension
1. Open Google Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked** and select the `apps/extension/` directory.
4. Record the generated **Extension ID** for the next step.

### 4. Setup Native Messaging Host
Run the macOS setup script to register the agent with Chrome, passing your exact Extension ID:
```bash
./scripts/setup-native-host-macos.sh <EXTENSION_ID>
```

---

## Test Execution Phase

### Test 1 — Extension
1. Open `chrome://extensions/`
2. Verify ShadowShield is loaded with no manifest errors.
3. Verify the Service Worker is active.
4. Navigate to `https://chatgpt.com/` and check the browser DevTools console. Verify the content script runs only on this origin.
**Record: [ ] PASS / [ ] FAIL**

### Test 2 — Native Agent
1. With `https://chatgpt.com/` open, check the DevTools Console.
2. Verify the log shows `ShadowShield: Native agent connected`.
3. Check the Extension Service Worker console. Verify Health check succeeds and no connection errors exist.
**Record: [ ] PASS / [ ] FAIL**

### Test 3 — Adapter Discovery
1. Look at the `chatgpt.com` DOM.
2. Verify the `ChatGPTAdapter` recognizes the page and discovers the composer (`#prompt-textarea` or fallback).
3. The ShadowShield internal state should transition to **Protected**.
**Record: [ ] PASS / [ ] FAIL**

### Test 4 — Neutral ALLOW
1. Type neutral, non-sensitive text (e.g., "Hello world") into the ChatGPT composer.
2. Press Enter to submit.
3. **Verify:**
   - AI Access allows the request.
   - DLP Inspect finds zero detections.
   - The submission proceeds exactly once.
   - No infinite event loops occur.
   - No visible text corruption.
**Record: [ ] PASS / [ ] FAIL**

### Test 5 — Keyboard Behaviors
1. Type neutral text and press `Shift + Enter`.
   - **Verify:** Normal editor behavior (a newline is added), NO submission interception.
2. If available, use an IME (Input Method Editor) composition.
   - **Verify:** Composition does not trigger submission.
**Record: [ ] PASS / [ ] FAIL**

### Test 6 — Send Button
1. Type neutral text.
2. Click the ChatGPT "Send" button instead of pressing Enter.
3. **Verify:**
   - Submission is intercepted and inspected.
   - Exactly one final submission is sent to ChatGPT.
   - No duplicate sends.
**Record: [ ] PASS / [ ] FAIL**

### Test 7 — SPA Navigation
1. Navigate to a "New Chat" or an existing conversation.
2. **Verify:**
   - Composer replacement is handled dynamically.
   - Protection remains **Protected**.
   - No duplicate listeners or repeated banners appear.
**Record: [ ] PASS / [ ] FAIL**

### Test 8 — Agent Disconnect
1. While `https://chatgpt.com/` is open, kill the Native Messaging Host process or rename the binary temporarily.
2. Attempt to submit a neutral prompt.
3. **Verify:**
   - State becomes **Disconnected**.
   - Submission **FAILS CLOSED** (the prompt is not sent to ChatGPT).
   - Reconnect the agent and verify recovery flow.
**Record: [ ] PASS / [ ] FAIL**

---

## Enforcement Test Strategy

For the following tests, use ONLY existing approved safe test fixtures (e.g., test credit cards that pass luhn but are inactive, or mock API keys).

### REDACT Live Test
1. Input a fixture known to trigger a High Risk → **Redact** policy.
2. Press Enter.
3. **Verify:**
   - The original intercepted text NEVER reaches ChatGPT.
   - The sanitized text appears in the chat log.
   - ShadowShield UI displays a generic **Data Redacted** banner.
**Record: [ ] PASS / [ ] FAIL**

### BLOCK Live Test
1. Input a fixture known to trigger a Critical Risk → **Block** policy.
2. Press Enter.
3. **Verify:**
   - ChatGPT receives nothing.
   - The composer retains its original content.
   - ShadowShield UI displays a generic **Submission Blocked** banner.
**Record: [ ] PASS / [ ] FAIL**

### COACH Live Test
1. Input a fixture known to trigger a Medium Risk → **Coach** policy.
2. Press Enter.
3. **Verify:**
   - Submission is stopped.
   - UI displays a **Coach** warning.
4. Click **Cancel**.
   - **Verify:** No submission occurs.
5. Trigger it again, but click **Proceed Anyway**.
   - **Verify:** DLP flow is respected, and exactly one submission is sent to ChatGPT.
**Record: [ ] PASS / [ ] FAIL**
