import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claude';
import { InterceptedSubmission } from '../../src/adapters/types';
import util from 'util';

if (!globalThis.crypto) (globalThis as any).crypto = {};
if (!globalThis.crypto.subtle) (globalThis as any).crypto.subtle = {};
globalThis.crypto.subtle.digest = async (_: string, data: Uint8Array) =>
    new Uint8Array([data[0] || 0, data[1] || 1, 2, 3]).buffer;
if (!globalThis.TextEncoder) (globalThis as any).TextEncoder = util.TextEncoder;

// --- DOM helpers ---

function buildContenteditableDom(ariaLabel = 'Write your prompt to Claude', withDataPlaceholder = true) {
    document.body.innerHTML = `
        <main>
            <div
                contenteditable="true"
                role="textbox"
                aria-label="${ariaLabel}"
                ${withDataPlaceholder ? 'data-placeholder="How can Claude help you today?"' : ''}
            ></div>
            <button aria-label="Send message">Send</button>
        </main>
    `;
}

function buildRichTextareaWithAriaLabel(ariaLabel = 'Write your prompt to Claude') {
    document.body.innerHTML = `
        <main>
            <div
                contenteditable="true"
                data-placeholder="How can Claude help you today?"
                aria-label="${ariaLabel}"
            ></div>
            <button aria-label="Send message">Send</button>
        </main>
    `;
}

describe('ClaudeAdapter', () => {
    let adapter: ClaudeAdapter;

    beforeEach(() => {
        document.body.innerHTML = '';
        adapter = new ClaudeAdapter();
    });

    afterEach(() => {
        adapter.dispose();
        vi.useRealTimers();
    });

    // =========================================================================
    // SERVICE ID / PAGE MATCH
    // =========================================================================
    describe('Service identity', () => {
        it('serviceId returns "claude"', () => {
            expect(adapter.serviceId()).toBe('claude');
        });

        it('matchesCurrentPage is true for claude.ai', () => {
            Object.defineProperty(window, 'location', {
                value: { hostname: 'claude.ai' }, writable: true, configurable: true
            });
            expect(adapter.matchesCurrentPage()).toBe(true);
        });

        it('matchesCurrentPage is false for other hosts', () => {
            Object.defineProperty(window, 'location', {
                value: { hostname: 'chatgpt.com' }, writable: true, configurable: true
            });
            expect(adapter.matchesCurrentPage()).toBe(false);
        });
    });

    // =========================================================================
    // COMPOSER DISCOVERY
    // =========================================================================
    describe('Composer Discovery', () => {
        it('A. finds contenteditable with data-placeholder and claude aria-label', () => {
            buildContenteditableDom('Write your prompt to Claude');
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer).not.toBeNull();
        });

        it('A2. finds contenteditable with "message" in aria-label', () => {
            buildContenteditableDom('Message Claude');
            expect(adapter.discoverComposer()).toBe('FOUND');
        });

        it('B. falls back to semantic single contenteditable in main (no aria match)', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true" data-placeholder="Ask anything"></div>
                    <button aria-label="Send message">Send</button>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
        });

        it('C. returns NOT_FOUND with no composer on page', () => {
            document.body.innerHTML = `<main><div>Loading...</div></main>`;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
            expect((adapter as any).composer).toBeNull();
        });

        it('C2. does NOT select contenteditable outside main/form (selector safety)', () => {
            document.body.innerHTML = `
                <aside>
                    <div contenteditable="true" data-placeholder="Search"></div>
                </aside>
            `;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
        });

        it('C3. does NOT trigger DEGRADED from unrelated aside contenteditable', () => {
            document.body.innerHTML = `
                <aside>
                    <div contenteditable="true">search1</div>
                    <div contenteditable="true">search2</div>
                </aside>
                <main>
                    <div contenteditable="true" aria-label="Write your prompt to Claude" data-placeholder="Ask Claude"></div>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer?.getAttribute('aria-label')).toBe('Write your prompt to Claude');
        });

        it('D. returns DEGRADED when multiple contenteditable in main are ambiguous', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true" id="a">One</div>
                    <div contenteditable="true" id="b">Two</div>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('DEGRADED');
            expect((adapter as any).composer).toBeNull();
        });

        it('discovers send button via aria-label', () => {
            buildContenteditableDom();
            adapter.discoverComposer();
            expect((adapter as any).sendButton).not.toBeNull();
        });

        it('does not mistake voice/attachment buttons for send', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true" aria-label="Write your prompt to Claude" data-placeholder="Ask"></div>
                    <button aria-label="Attach file">📎</button>
                    <button aria-label="Record audio">🎤</button>
                </main>
            `;
            adapter.discoverComposer();
            expect((adapter as any).sendButton).toBeNull();
        });
    });

    // =========================================================================
    // READ / WRITE
    // =========================================================================
    describe('Read/Write (contenteditable)', () => {
        beforeEach(() => {
            buildContenteditableDom();
            adapter.discoverComposer();
        });

        it('reads text from contenteditable via innerText', () => {
            const el = document.querySelector('[contenteditable="true"]') as HTMLElement;
            el.textContent = 'hello claude';
            expect(adapter.readComposerText()).toBe('hello claude');
        });

        it('writes text to contenteditable and dispatches input event', () => {
            const el = document.querySelector('[contenteditable="true"]') as HTMLElement;
            let inputFired = false;
            el.addEventListener('input', () => { inputFired = true; });
            adapter.writeComposerText('sanitized neutral text');
            expect(el.textContent).toBe('sanitized neutral text');
            expect(inputFired).toBe(true);
        });

        it('re-reading after write returns the written text', () => {
            adapter.writeComposerText('sanitized neutral text');
            expect(adapter.readComposerText()).toBe('sanitized neutral text');
        });
    });

    // =========================================================================
    // KEYBOARD INTERCEPTION
    // =========================================================================
    describe('Keyboard Interception', () => {
        let submitCount: number;
        let composer: HTMLElement;

        beforeEach(() => {
            submitCount = 0;
            buildContenteditableDom();
            adapter.discoverComposer();
            composer = document.querySelector('[contenteditable="true"]') as HTMLElement;
            composer.textContent = 'test content';
            adapter.interceptSubmission(() => { submitCount++; });
        });

        it('intercepts plain Enter', async () => {
            const ev = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
            composer.dispatchEvent(ev);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
            expect(ev.defaultPrevented).toBe(true);
        });

        it('does not intercept Shift+Enter', async () => {
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('does not intercept IME Enter (isComposing)', async () => {
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('does not intercept Meta+Enter', async () => {
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('does not intercept Ctrl+Enter', async () => {
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });
    });

    // =========================================================================
    // SEND BUTTON INTERCEPTION
    // =========================================================================
    describe('Send Button Interception', () => {
        it('intercepts click on recognized send button', async () => {
            let submitCount = 0;
            buildContenteditableDom();
            adapter.discoverComposer();
            const composer = document.querySelector('[contenteditable="true"]') as HTMLElement;
            composer.textContent = 'test';
            adapter.interceptSubmission(() => { submitCount++; });

            const btn = document.querySelector('button[aria-label="Send message"]') as HTMLElement;
            const ev = new MouseEvent('click', { cancelable: true, bubbles: true });
            btn.dispatchEvent(ev);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
            expect(ev.defaultPrevented).toBe(true);
        });
    });

    // =========================================================================
    // SPA REPLACEMENT
    // =========================================================================
    describe('SPA Replacement / MutationObserver', () => {
        it('E. detects new composer after SPA navigation', async () => {
            vi.useFakeTimers();
            adapter.interceptSubmission(() => {});

            buildContenteditableDom();
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).toBe('Protected');

            // SPA: replace composer
            document.body.innerHTML = `<main><div contenteditable="true" aria-label="Write your prompt to Claude" data-placeholder="Ask Claude">New</div></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).toBe('Protected');
        });

        it('F. no duplicate listeners after burst of DOM changes', async () => {
            vi.useFakeTimers();
            let submitCount = 0;
            adapter.interceptSubmission(() => { submitCount++; });

            buildContenteditableDom();
            await Promise.resolve();
            document.body.innerHTML = `<main><div contenteditable="true" aria-label="Write your prompt to Claude" data-placeholder="A">A</div></main>`;
            await Promise.resolve();
            document.body.innerHTML = `<main><div contenteditable="true" aria-label="Write your prompt to Claude" data-placeholder="B">B</div></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);

            const composer = document.querySelector('[contenteditable="true"]') as HTMLElement;
            composer.textContent = 'test';
            vi.useRealTimers();
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
        });

        it('drops to non-Protected on detachment without replacement', async () => {
            vi.useFakeTimers();
            adapter.interceptSubmission(() => {});
            buildContenteditableDom();
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).toBe('Protected');

            document.body.innerHTML = `<main><div>Loading...</div></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).not.toBe('Protected');
        });

        it('cleans up on dispose', () => {
            adapter.interceptSubmission(() => {});
            buildContenteditableDom();
            adapter.discoverComposer();
            adapter.dispose();
            expect((adapter as any).mutationObserver).toBeNull();
        });
    });

    // =========================================================================
    // G. NOT_FOUND on supported host without composer
    // =========================================================================
    describe('G. NOT_FOUND on authenticated page without loaded composer', () => {
        it('returns NOT_FOUND when claude.ai is loaded but composer not yet rendered', () => {
            document.body.innerHTML = `<main><div class="loading-spinner"></div></main>`;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
            expect((adapter as any).state).not.toBe('Protected');
        });
    });
});
