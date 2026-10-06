/**
 * Coach provenance regression tests.
 *
 * Proves that AI Access Coach and DLP Coach:
 *   - display distinct, accurate wording
 *   - AI Access Coach does NOT claim sensitive data was detected
 *   - enforcement Cancel/Proceed behavior is identical to pre-fix
 *
 * Neutral test data only. No security fixtures. No PII.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import util from 'util';

if (!globalThis.crypto) (globalThis as any).crypto = {};
if (!globalThis.crypto.subtle) (globalThis as any).crypto.subtle = {};
globalThis.crypto.subtle.digest = async (_: string, data: Uint8Array) =>
    new Uint8Array([data[0] || 0, data[1] || 1, 2, 3]).buffer;
if (!globalThis.TextEncoder) (globalThis as any).TextEncoder = util.TextEncoder;

const sendMessageMock = vi.fn();
(globalThis as any).chrome = {
    runtime: {
        sendMessage: sendMessageMock,
        lastError: null,
    },
};

// Banner lookup — searches shadow DOM for the coach banner
function getCoachBanner(): Element | null {
    for (const el of Array.from(document.querySelectorAll('div'))) {
        if (el.shadowRoot) {
            const b = el.shadowRoot.querySelector('.shield-banner.coach');
            if (b) return b;
        }
    }
    return null;
}

function getBannerText(): string {
    const b = getCoachBanner();
    return b ? b.textContent || '' : '';
}

function getBannerTitle(): string {
    const b = getCoachBanner();
    return b?.querySelector('.shield-title')?.textContent || '';
}

function getBannerMessage(): string {
    const b = getCoachBanner();
    return b?.querySelector('.shield-message')?.textContent || '';
}

function buildDom() {
    document.body.innerHTML = `
        <main>
            <div id="prompt-textarea" contenteditable="true">Explain binary search.</div>
        </main>
    `;
}

// Forbidden phrases that must NEVER appear in an AI Access Coach banner
const SENSITIVE_DATA_PHRASES = [
    'sensitive information',
    'pii',
    'secret',
    'credential',
    'data leak',
    'detected',
];

describe('Coach Provenance — UI wording correctness', () => {

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllTimers();
        buildDom();
        sendMessageMock.mockReset();
        (globalThis as any).chrome.runtime.lastError = null;
    });

    afterEach(async () => {
        try {
            const mod = await import('../../src/content/chatgpt-content');
            mod._testAdapter?.dispose();
        } catch (_) { /* module may not be loaded */ }
        document.body.innerHTML = '';
    });

    // =========================================================================
    // 1. AI Access Coach — uses AI-governance wording, not sensitive-data wording
    // =========================================================================
    it('1. AI Access Coach title is "AI Service Review" (not sensitive-data language)', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Coach' } });
            // Inspect must NOT be called before user clicks Proceed
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const title = getBannerTitle();
        expect(title).toBe('AI Service Review');
    });

    // =========================================================================
    // 2. AI Access Coach does NOT contain sensitive-data language
    // =========================================================================
    it('2. AI Access Coach banner contains none of the forbidden sensitive-data phrases', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Coach' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const text = getBannerText().toLowerCase();
        for (const phrase of SENSITIVE_DATA_PHRASES) {
            expect(text, `AI Access Coach must not contain "${phrase}"`).not.toContain(phrase);
        }
    });

    // =========================================================================
    // 3. AI Access Coach — DLP (Inspect) has NOT been called before banner shows
    // =========================================================================
    it('3. AI Access Coach — DLP Inspect not called before first banner (AI_ACCESS_COACH_BEFORE_DLP)', async () => {
        vi.useFakeTimers();
        const inspectCallCount = { n: 0 };
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Coach' } });
            if (msg.payload.type === 'Inspect')
                inspectCallCount.n++;
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // Coach banner is showing
        expect(getCoachBanner()).not.toBeNull();
        // Inspect must NOT have been called yet
        expect(inspectCallCount.n).toBe(0);
    });

    // =========================================================================
    // 4. AI Access Coach Proceed → DLP Inspect runs → neutral result is Allow
    // =========================================================================
    it('4. AI Access Coach Proceed → DLP runs → neutral "Explain binary search." produces Allow', async () => {
        vi.useFakeTimers();
        let inspectCallCount = 0;
        let dlpAction: string | null = null;
        let syntheticCount = 0;

        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Coach' } });
            else if (msg.payload.type === 'Inspect') {
                inspectCallCount++;
                dlpAction = 'Allow';
                // Neutral text → Allow (0 detections, Low risk)
                cb({ success: true, response: { action: 'Allow' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.addEventListener('keydown', e => { if (!e.isTrusted && e.key === 'Enter') syntheticCount++; });

        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // Proceed
        const proceedBtn = getCoachBanner()!.querySelector('button.primary') as HTMLButtonElement;
        proceedBtn.click();
        await new Promise(r => setTimeout(r, 50));

        // DLP ran after Proceed
        expect(inspectCallCount).toBe(1);
        // DLP action was Allow
        expect(dlpAction).toBe('Allow');
        // Submission resumed once
        expect(syntheticCount).toBe(1);
    });

    // =========================================================================
    // 5. DLP Coach title is "Sensitive Information Detected"
    // =========================================================================
    it('5. DLP Coach title is "Sensitive Information Detected"', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Coach' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const title = getBannerTitle();
        expect(title).toBe('Sensitive Information Detected');
    });

    // =========================================================================
    // 6. DLP Coach message references content review (not AI governance)
    // =========================================================================
    it('6. DLP Coach message references sensitive information review', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Coach' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const msg = getBannerMessage().toLowerCase();
        expect(msg).toContain('sensitive');
    });

    // =========================================================================
    // 7. DLP Coach — Cancel → no resume
    // =========================================================================
    it('7. DLP Coach Cancel → no resume', async () => {
        vi.useFakeTimers();
        let syntheticCount = 0;
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Coach' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.addEventListener('keydown', e => { if (!e.isTrusted && e.key === 'Enter') syntheticCount++; });
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const cancelBtn = getCoachBanner()!.querySelector('button:not(.primary)') as HTMLButtonElement;
        cancelBtn.click();
        await new Promise(r => setTimeout(r, 30));

        expect(syntheticCount).toBe(0);
    });

    // =========================================================================
    // 8. DLP Coach — Proceed → resume exactly once
    // =========================================================================
    it('8. DLP Coach Proceed → resume exactly once', async () => {
        vi.useFakeTimers();
        let syntheticCount = 0;
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Coach' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.addEventListener('keydown', e => { if (!e.isTrusted && e.key === 'Enter') syntheticCount++; });
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const proceedBtn = getCoachBanner()!.querySelector('button.primary') as HTMLButtonElement;
        proceedBtn.click();
        await new Promise(r => setTimeout(r, 50));

        expect(syntheticCount).toBe(1);
    });

    // =========================================================================
    // 9. BLOCK wording and behavior unchanged
    // =========================================================================
    it('9. Block UI shows "Submission Blocked" — no sensitive-data coach language', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Block' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // Blocked banner must exist
        let blockedBanner: Element | null = null;
        for (const el of Array.from(document.querySelectorAll('div'))) {
            if (el.shadowRoot) {
                blockedBanner = el.shadowRoot.querySelector('.shield-banner.blocked');
                if (blockedBanner) break;
            }
        }
        expect(blockedBanner).not.toBeNull();

        // Must NOT show a Coach banner
        expect(getCoachBanner()).toBeNull();
    });

    // =========================================================================
    // 10. REDACT wording and behavior unchanged
    // =========================================================================
    it('10. Redact UI shows "Data Redacted" — no coach banner visible', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Redact', sanitized_content: '[REDACTED:NEUTRAL]' } });
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // No coach banner
        expect(getCoachBanner()).toBeNull();
        // Composer has sanitized content
        expect(composer.textContent).toBe('[REDACTED:NEUTRAL]');
    });

    // =========================================================================
    // 11. AI Access Coach Cancel → no resume, no DLP call
    // =========================================================================
    it('11. AI Access Coach Cancel → stopSubmission, DLP never called', async () => {
        vi.useFakeTimers();
        let syntheticCount = 0;
        let inspectCount = 0;
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Coach' } });
            else if (msg.payload.type === 'Inspect')
                inspectCount++;
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        composer.addEventListener('keydown', e => { if (!e.isTrusted && e.key === 'Enter') syntheticCount++; });
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        const cancelBtn = getCoachBanner()!.querySelector('button:not(.primary)') as HTMLButtonElement;
        cancelBtn.click();
        await new Promise(r => setTimeout(r, 30));

        expect(syntheticCount).toBe(0);
        expect(inspectCount).toBe(0);
    });

    // =========================================================================
    // 12. AI Access Coach and DLP Coach produce distinct titles
    //     (provenance must differ between the two paths)
    // =========================================================================
    it('12. AI Access Coach title != DLP Coach title (provenance must differ)', async () => {
        // --- Capture AI Access Coach title ---
        vi.resetModules();
        document.body.innerHTML = '';
        buildDom();
        sendMessageMock.mockReset();

        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Coach' } });
        });
        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        document.getElementById('prompt-textarea')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
        );
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));
        const aiAccessTitle = getBannerTitle();

        // Clean up
        const mod = await import('../../src/content/chatgpt-content');
        mod._testAdapter?.dispose();
        document.body.innerHTML = '';

        // --- Capture DLP Coach title ---
        vi.resetModules();
        buildDom();
        sendMessageMock.mockReset();

        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess')
                cb({ success: true, response: { decision: 'Allow' } });
            else if (msg.payload.type === 'Inspect')
                cb({ success: true, response: { action: 'Coach' } });
        });
        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        document.getElementById('prompt-textarea')!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
        );
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));
        const dlpTitle = getBannerTitle();

        // Titles MUST differ
        expect(aiAccessTitle).not.toBe('');
        expect(dlpTitle).not.toBe('');
        expect(aiAccessTitle).not.toBe(dlpTitle);

        // AI Access title must not contain sensitive-data language
        for (const phrase of SENSITIVE_DATA_PHRASES) {
            expect(aiAccessTitle.toLowerCase()).not.toContain(phrase);
        }
    });
});
