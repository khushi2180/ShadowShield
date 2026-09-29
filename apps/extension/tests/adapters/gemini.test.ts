import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiAdapter } from '../../src/adapters/gemini';
import util from 'util';

if (!globalThis.crypto) (globalThis as any).crypto = {};
if (!globalThis.crypto.subtle) (globalThis as any).crypto.subtle = {};
globalThis.crypto.subtle.digest = async (_: string, data: Uint8Array) =>
    new Uint8Array([data[0] || 0, data[1] || 1, 2, 3]).buffer;
if (!globalThis.TextEncoder) (globalThis as any).TextEncoder = util.TextEncoder;

// --- DOM helpers ---

function buildRichTextareaDom(ariaLabel = 'Enter a prompt here') {
    document.body.innerHTML = `
        <main>
            <rich-textarea>
                <div
                    contenteditable="true"
                    aria-label="${ariaLabel}"
                    aria-multiline="true"
                    class="ql-editor"
                ></div>
            </rich-textarea>
            <button aria-label="Send message" type="button">Send</button>
        </main>
    `;
}

function buildDirectContenteditableDom(ariaLabel = 'Enter a prompt here') {
    document.body.innerHTML = `
        <main>
            <div
                contenteditable="true"
                aria-label="${ariaLabel}"
                aria-multiline="true"
            ></div>
            <button aria-label="Send message">Send</button>
        </main>
    `;
}

describe('GeminiAdapter', () => {
    let adapter: GeminiAdapter;

    beforeEach(() => {
        document.body.innerHTML = '';
        adapter = new GeminiAdapter();
    });

    afterEach(() => {
        adapter.dispose();
        vi.useRealTimers();
    });

    // =========================================================================
    // SERVICE ID / PAGE MATCH
    // =========================================================================
    describe('Service identity', () => {
        it('serviceId returns "gemini"', () => {
            expect(adapter.serviceId()).toBe('gemini');
        });

        it('matchesCurrentPage is true for gemini.google.com', () => {
            Object.defineProperty(window, 'location', {
                value: { hostname: 'gemini.google.com' }, writable: true, configurable: true
            });
            expect(adapter.matchesCurrentPage()).toBe(true);
        });

        it('matchesCurrentPage is false for other hosts', () => {
            Object.defineProperty(window, 'location', {
                value: { hostname: 'claude.ai' }, writable: true, configurable: true
            });
            expect(adapter.matchesCurrentPage()).toBe(false);
        });
    });

    // =========================================================================
    // COMPOSER DISCOVERY
    // =========================================================================
    describe('Composer Discovery', () => {
        it('A. finds contenteditable inside rich-textarea component', () => {
            buildRichTextareaDom('Enter a prompt here');
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer).not.toBeNull();
        });

        it('A2. finds direct contenteditable with "enter a prompt" aria-label', () => {
            buildDirectContenteditableDom('Enter a prompt here');
            expect(adapter.discoverComposer()).toBe('FOUND');
        });

        it('A3. finds direct contenteditable with "message gemini" aria-label', () => {
            buildDirectContenteditableDom('Message Gemini');
            expect(adapter.discoverComposer()).toBe('FOUND');
        });

        it('B. falls back to semantic single contenteditable in main', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true"></div>
                    <button aria-label="Send message">Send</button>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
        });

        it('C. returns NOT_FOUND when no composer on page (login wall)', () => {
            document.body.innerHTML = `<div>Sign in with Google to continue</div>`;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
        });

        it('C2. does NOT select contenteditable in sidebar/aside', () => {
            document.body.innerHTML = `
                <aside>
                    <div contenteditable="true" aria-label="Search">search</div>
                </aside>
            `;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
        });

        it('C3. does NOT trigger DEGRADED from nav contenteditable', () => {
            document.body.innerHTML = `
                <nav>
                    <div contenteditable="true" aria-label="Search history">nav</div>
                </nav>
                <main>
                    <div contenteditable="true" aria-label="Enter a prompt here"></div>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer?.getAttribute('aria-label')).toBe('Enter a prompt here');
        });

        it('D. returns DEGRADED with multiple ambiguous contenteditable in main', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true" id="a">One</div>
                    <div contenteditable="true" id="b">Two</div>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('DEGRADED');
        });

        it('discovers send button via aria-label "Send message"', () => {
            buildDirectContenteditableDom();
            adapter.discoverComposer();
            expect((adapter as any).sendButton).not.toBeNull();
        });

        it('does not mistake upload/attach buttons for send', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true" aria-label="Enter a prompt here"></div>
                    <button aria-label="Add an image">📷</button>
                    <button aria-label="Upload file">📎</button>
                    <button aria-label="Use microphone">🎤</button>
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
            buildDirectContenteditableDom();
            adapter.discoverComposer();
        });

        it('reads text from contenteditable', () => {
            const el = document.querySelector('[contenteditable="true"]') as HTMLElement;
            el.textContent = 'hello gemini';
            expect(adapter.readComposerText()).toBe('hello gemini');
        });

        it('writes text and dispatches input event', () => {
            const el = document.querySelector('[contenteditable="true"]') as HTMLElement;
            let inputFired = false;
            el.addEventListener('input', () => { inputFired = true; });
            adapter.writeComposerText('sanitized content');
            expect(el.textContent).toBe('sanitized content');
            expect(inputFired).toBe(true);
        });

        it('re-reading after write returns the written text', () => {
            adapter.writeComposerText('sanitized content');
            expect(adapter.readComposerText()).toBe('sanitized content');
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
            buildDirectContenteditableDom();
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
            buildDirectContenteditableDom();
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

            buildDirectContenteditableDom();
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).toBe('Protected');

            document.body.innerHTML = `<main><div contenteditable="true" aria-label="Enter a prompt here">New</div></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).toBe('Protected');
        });

        it('F. no duplicate listeners after burst of DOM changes', async () => {
            vi.useFakeTimers();
            let submitCount = 0;
            adapter.interceptSubmission(() => { submitCount++; });

            buildDirectContenteditableDom();
            await Promise.resolve();
            document.body.innerHTML = `<main><div contenteditable="true" aria-label="Enter a prompt here">A</div></main>`;
            await Promise.resolve();
            document.body.innerHTML = `<main><div contenteditable="true" aria-label="Enter a prompt here">B</div></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);

            const composer = document.querySelector('[contenteditable="true"]') as HTMLElement;
            composer.textContent = 'test';
            vi.useRealTimers();
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
        });

        it('cleans up on dispose', () => {
            adapter.interceptSubmission(() => {});
            buildDirectContenteditableDom();
            adapter.discoverComposer();
            adapter.dispose();
            expect((adapter as any).mutationObserver).toBeNull();
        });
    });

    // =========================================================================
    // G. NOT_FOUND on auth wall
    // =========================================================================
    describe('G. NOT_FOUND on login page', () => {
        it('returns NOT_FOUND when Gemini shows sign-in page', () => {
            document.body.innerHTML = `
                <div class="sign-in-page">
                    <h1>Sign in to continue</h1>
                    <button>Sign in with Google</button>
                </div>
            `;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
            expect((adapter as any).state).not.toBe('Protected');
        });
    });
});
