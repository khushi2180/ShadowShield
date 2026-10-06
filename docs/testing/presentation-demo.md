# ShadowShield Presentation Demo

## 0. Before presentation

Commands:

cargo build --workspace

cd apps/extension
pnpm build

Then native-host verification.

Chrome extension reload instructions only if necessary.

## 1. Explain architecture

30-second explanation:

Browser composer
→ ShadowShield extension
→ Native Messaging
→ Rust agent
→ AI Access policy
→ DLP
→ Allow / Coach / Redact / Block

## 2. Neutral demo

Use neutral sentence:

Explain binary search in one sentence.

Expected:
    
→ message sends once

Explain:

Presentation policy:
ChatGPT = Approved
Gemini = Approved
Claude = Unknown

Approved means:
AI service usage is permitted,
BUT every prompt still passes through local DLP.

## 3. REDACT demo

Copy approved fixture pii.payment_card.doc.1 from the repository fixture mechanism.

Expected:
    
→ Data Redacted
→ sanitized placeholder submitted
→ original value never reaches provider

## 4. BLOCK demo

Use ONLY repository-approved BLOCK fixture.

Expected:

→ Submission Blocked
→ provider receives nothing

## 5. Gemini optional demo

Show that the same architecture protects a second AI provider.

Use neutral prompt only unless presentation time allows.

## 6. Talking points

- deterministic local enforcement
- no ML required for current policy engine
- no external security scoring API
- Native Messaging boundary
- raw sensitive data is inspected locally
- AI Access and DLP are independent
- same security controller works across providers
- privacy-safe UI/logging

## 7. Honest limitations

- Claude adapter implemented but live verification pending authentication
- file/image/voice uploads not protected in V1
- assistant/output DLP not implemented
- Degraded is warning-only, not page-wide fail-closed
- browser DOM integrations can require compatibility updates
- IDE protection is planned V2, not current demo

## 8. Demo Failure Fallback

If live ChatGPT fails:

1. Do NOT debug during presentation.
2. Switch to Gemini.
3. If Gemini also unavailable, show automated test results:
   TypeScript test total
   Rust test total
4. Explain previously live-verified REDACT/BLOCK architecture.
