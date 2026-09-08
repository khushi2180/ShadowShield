import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import util from 'util';

if (!globalThis.crypto) {
    (globalThis as any).crypto = {};
}
if (!globalThis.crypto.subtle) {
    (globalThis as any).crypto.subtle = {};
}

// Unconditionally mock digest because fakeTimers break native crypto.subtle.digest
globalThis.crypto.subtle.digest = async (algo: string, data: Uint8Array) => {
    return new Uint8Array([data[0] || 0, data[1] || 1, 2, 3]).buffer;
};
if (!globalThis.TextEncoder) {
    (globalThis as any).TextEncoder = util.TextEncoder;
}

// Mock chrome API globally
const sendMessageMock = vi.fn();
(globalThis as any).chrome = {
    runtime: {
        sendMessage: sendMessageMock,
        lastError: null
    }
};

describe('Content Script End-to-End Tests', () => {
    function getBanner(selector: string) {
        const containers = Array.from(document.querySelectorAll('div'));
        for (const c of containers) {
            if (c.shadowRoot) {
                const targetClass = selector.replace('.shield-banner.', '');
                // Iterate over all children of shadowRoot
                const children = Array.from(c.shadowRoot.childNodes);
                for (let i = 0; i < children.length; i++) {
                    const child = children[i] as HTMLElement;
                    // MUST be a DIV, not a STYLE tag!
                    if (child.tagName === 'DIV' && child.outerHTML && child.outerHTML.includes(targetClass)) {
                        return child; // Return the real DOM element!
                    }
                }
            }
        }
        return null;
    }

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllTimers();
        document.body.innerHTML = `
            <main>
                <div id="prompt-textarea" contenteditable="true">Neutral text</div>
            </main>
        `;
        sendMessageMock.mockReset();
        (globalThis as any).chrome.runtime.lastError = null;
    });

    afterEach(async () => {
        try {
            const mod = await import('../../src/content/chatgpt-content');
            if (mod && mod._testAdapter) {
                mod._testAdapter.dispose();
            }
        } catch (e) {
            // Module might not have been loaded in this test
        }
        document.body.innerHTML = '';
    });

    it('should process ALLOW workflow exactly once (AI Access -> Low/Allow)', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess') {
                cb({ success: true, response: { decision: 'Allow' } });
            } else if (msg.payload.type === 'Inspect') {
                cb({ success: true, response: { action: 'Allow' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        
        // Find composer
        const composer = document.getElementById('prompt-textarea')!;
        let syntheticSubmitCount = 0;
        composer.addEventListener('keydown', (e) => {
            if (e.isTrusted === false && e.key === 'Enter') syntheticSubmitCount++;
        });

        // Trigger user submit
        const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
        composer.dispatchEvent(event);
        vi.useRealTimers();
        
        expect(event.defaultPrevented).toBe(true);

        // Wait for promises to resolve
        await new Promise(r => setTimeout(r, 50));

        // Exactly one native access check, one native inspect check
        expect(sendMessageMock).toHaveBeenCalledTimes(2);
        
        // Exactly one resumed submission
        expect(syntheticSubmitCount).toBe(1);
    });

    it('should process AI Access BLOCK workflow', async () => {
        console.log("BLOCK test started");
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            console.log("BLOCK test mock called", msg);
            if (msg.payload.type === 'EvaluateAiAccess') {
                cb({ success: true, response: { decision: 'Block' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        
        // Dummy listener for JSDOM bug?
        composer.addEventListener('keydown', () => {});
        
        console.log("BLOCK test dispatching event");
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // 1 request (no inspect request)
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
        
        // UI shown block
        expect(getBanner('.shield-banner.blocked')).not.toBeNull();
    });

    it('should process AI Access COACH workflow', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess') {
                cb({ success: true, response: { decision: 'Coach' } });
            } else if (msg.payload.type === 'Inspect') {
                cb({ success: true, response: { action: 'Allow' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        
        let syntheticSubmitCount = 0;
        composer.addEventListener('keydown', (e) => {
            if (e.isTrusted === false && e.key === 'Enter') syntheticSubmitCount++;
        });

        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        expect(sendMessageMock).toHaveBeenCalledTimes(1); // No inspect
        const banner = getBanner('.shield-banner.coach');
        expect(banner).not.toBeNull();
        expect(syntheticSubmitCount).toBe(0);

        // Click proceed
        const proceedBtn = banner!.querySelector('button.primary') as HTMLButtonElement;
        proceedBtn.click();
        
        await new Promise(r => setTimeout(r, 50));
        
        // One resumed submission
        expect(syntheticSubmitCount).toBe(1);
    });

    it('should process Data Policy BLOCK workflow', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess') {
                cb({ success: true, response: { decision: 'Allow' } });
            } else if (msg.payload.type === 'Inspect') {
                cb({ success: true, response: { action: 'Block' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        expect(sendMessageMock).toHaveBeenCalledTimes(2);
        
        // Block UI shown
        expect(getBanner('.shield-banner.blocked')).not.toBeNull();
    });

    it('should process REDACT workflow successfully', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess') {
                cb({ success: true, response: { decision: 'Allow' } });
            } else if (msg.payload.type === 'Inspect') {
                cb({ success: true, response: { action: 'Redact', sanitized_content: 'Redacted text' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        
        let syntheticSubmitCount = 0;
        composer.addEventListener('keydown', (e) => {
            if (e.isTrusted === false && e.key === 'Enter') syntheticSubmitCount++;
        });

        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        expect(sendMessageMock).toHaveBeenCalledTimes(2);
        expect(composer.textContent).toBe('Redacted text');
        expect(syntheticSubmitCount).toBe(1);
        expect(getBanner('.shield-banner.redacted')).not.toBeNull();
    });

    it('should FAIL CLOSED on REDACT if sanitized_content is missing', async () => {
        vi.useFakeTimers();
        sendMessageMock.mockImplementation((msg, cb) => {
            if (msg.payload.type === 'EvaluateAiAccess') {
                cb({ success: true, response: { decision: 'Allow' } });
            } else if (msg.payload.type === 'Inspect') {
                // Missing sanitized content!
                cb({ success: true, response: { action: 'Redact' } });
            }
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        
        let syntheticSubmitCount = 0;
        composer.addEventListener('keydown', (e) => {
            if (e.isTrusted === false && e.key === 'Enter') syntheticSubmitCount++;
        });

        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // Original content must not be submitted
        expect(syntheticSubmitCount).toBe(0);
        
        // Falls back to Block UI
        expect(getBanner('.shield-banner.blocked')).not.toBeNull();
    });

    it('should process Disconnected behavior', async () => {
        vi.useFakeTimers();
        // Mock disconnect
        (globalThis as any).chrome.runtime.lastError = { message: "Native host disconnected" };
        sendMessageMock.mockImplementation((msg, cb) => {
            cb(null);
        });

        await import('../../src/content/chatgpt-content');
        vi.advanceTimersByTime(3500);
        const composer = document.getElementById('prompt-textarea')!;
        
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 50));

        // Fail closed safely
        expect(getBanner('.shield-banner.disconnected')).not.toBeNull();
    });
});
