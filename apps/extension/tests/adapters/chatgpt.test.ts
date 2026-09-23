import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatGPTAdapter } from '../../src/adapters/chatgpt';
import { InterceptedSubmission } from '../../src/adapters/types';
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

// Helper: build a minimal textarea composer DOM (current ChatGPT structure)
function buildTextareaDom(id = 'mobile-composer-prompt', placeholder = 'Message ChatGPT') {
    document.body.innerHTML = `
        <main>
            <form>
                <textarea
                    id="${id}"
                    placeholder="${placeholder}"
                    aria-label="Message ChatGPT"
                    rows="1"
                ></textarea>
                <button data-testid="send-button" aria-label="Send message">Send</button>
            </form>
        </main>
    `;
}

// Helper: build a minimal contenteditable composer DOM (previous ChatGPT structure)
function buildContenteditableDom(id = 'prompt-textarea') {
    document.body.innerHTML = `
        <main>
            <div id="${id}" contenteditable="true" role="textbox" aria-label="Message ChatGPT"></div>
            <button data-testid="send-button" aria-label="Send message">Send</button>
        </main>
    `;
}

describe('ChatGPTAdapter', () => {
    let adapter: ChatGPTAdapter;

    beforeEach(() => {
        document.body.innerHTML = '';
        adapter = new ChatGPTAdapter();
    });

    afterEach(() => {
        adapter.dispose();
        vi.useRealTimers();
    });

    // ==========================================================================
    // COMPOSER DISCOVERY TESTS
    // ==========================================================================
    describe('Composer Discovery', () => {

        it('A. finds current textarea composer (#mobile-composer-prompt)', () => {
            buildTextareaDom('mobile-composer-prompt');
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer).not.toBeNull();
            expect((adapter as any).composer.tagName).toBe('TEXTAREA');
            expect((adapter as any).composer.id).toBe('mobile-composer-prompt');
        });

        it('B. finds previous contenteditable composer (#prompt-textarea)', () => {
            buildContenteditableDom('prompt-textarea');
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer).not.toBeNull();
            expect((adapter as any).composer.id).toBe('prompt-textarea');
        });

        it('B2. finds single textarea via semantic fallback in main/form', () => {
            document.body.innerHTML = `
                <main>
                    <textarea placeholder="Type here" aria-label="Prompt"></textarea>
                    <button data-testid="send-button">Send</button>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer?.tagName).toBe('TEXTAREA');
        });

        it('C. does NOT select an unrelated textarea outside main/form', () => {
            document.body.innerHTML = `
                <aside>
                    <textarea placeholder="Search..."></textarea>
                </aside>
            `;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
            expect((adapter as any).composer).toBeNull();
        });

        it('C2. does NOT select a search textarea in a sidebar (selector safety)', () => {
            // Simulates a page with a search/filter input in a sidebar alongside a main prompt
            document.body.innerHTML = `
                <nav>
                    <textarea id="search-input" placeholder="Search chats"></textarea>
                </nav>
                <main>
                    <textarea id="mobile-composer-prompt" placeholder="Message ChatGPT"></textarea>
                    <button data-testid="send-button">Send</button>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
            // Must bind to the main composer, NOT the nav/search one
            expect((adapter as any).composer?.id).toBe('mobile-composer-prompt');
        });

        it('C3. does NOT select a modal/dialog textarea (selector safety)', () => {
            // Simulates a rename/feedback modal that happens to be open
            document.body.innerHTML = `
                <dialog open>
                    <textarea id="rename-input" placeholder="Rename conversation"></textarea>
                </dialog>
                <main>
                    <textarea id="mobile-composer-prompt" placeholder="Message ChatGPT"></textarea>
                </main>
            `;
            expect(adapter.discoverComposer()).toBe('FOUND');
            // dialog textarea is not in main/form — must not be selected
            expect((adapter as any).composer?.id).toBe('mobile-composer-prompt');
        });

        it('C4. DEGRADED not triggered by unrelated sidebar textarea (only main/form counts)', () => {
            // Sidebar textarea outside main/form must not cause DEGRADED
            document.body.innerHTML = `
                <aside>
                    <textarea placeholder="Search..."></textarea>
                    <textarea placeholder="Filter..."></textarea>
                </aside>
                <main>
                    <textarea id="mobile-composer-prompt" placeholder="Message ChatGPT"></textarea>
                </main>
            `;
            // Only one textarea in main/form — should be FOUND, not DEGRADED
            expect(adapter.discoverComposer()).toBe('FOUND');
            expect((adapter as any).composer?.id).toBe('mobile-composer-prompt');
        });


        it('D. returns DEGRADED when multiple ambiguous textareas exist in main/form', () => {
            document.body.innerHTML = `
                <main>
                    <textarea id="first" placeholder="First"></textarea>
                    <textarea id="second" placeholder="Second"></textarea>
                </main>
            `;
            const result = adapter.discoverComposer();
            // Adapter must not bind to an unknown one
            expect(result).toBe('DEGRADED');
            expect((adapter as any).composer).toBeNull();
        });

        it('D2. returns DEGRADED when multiple contenteditable elements are ambiguous', () => {
            document.body.innerHTML = `
                <main>
                    <div contenteditable="true" id="a">One</div>
                    <div contenteditable="true" id="b">Two</div>
                </main>
            `;
            const result = adapter.discoverComposer();
            expect(result).toBe('DEGRADED');
            expect((adapter as any).composer).toBeNull();
        });

        it('returns NOT_FOUND when page has no recognized composer', () => {
            document.body.innerHTML = `<main><div>Just text</div></main>`;
            expect(adapter.discoverComposer()).toBe('NOT_FOUND');
        });

        it('discovers send button via data-testid', () => {
            buildTextareaDom();
            adapter.discoverComposer();
            expect((adapter as any).sendButton).not.toBeNull();
            expect((adapter as any).sendButton?.getAttribute('data-testid')).toBe('send-button');
        });

        it('discovers send button via aria-label fallback', () => {
            document.body.innerHTML = `
                <main>
                    <textarea id="mobile-composer-prompt"></textarea>
                    <button aria-label="Send message">→</button>
                </main>
            `;
            adapter.discoverComposer();
            expect((adapter as any).sendButton).not.toBeNull();
        });

        it('does not mistake voice/attachment buttons for send button', () => {
            document.body.innerHTML = `
                <main>
                    <textarea id="mobile-composer-prompt"></textarea>
                    <button aria-label="Attach file">📎</button>
                    <button aria-label="Record audio">🎤</button>
                </main>
            `;
            adapter.discoverComposer();
            // No send button found, sendButton should be null
            expect((adapter as any).sendButton).toBeNull();
        });
    });

    // ==========================================================================
    // TEXTAREA READ/WRITE TESTS
    // ==========================================================================
    describe('Textarea Read/Write', () => {

        beforeEach(() => {
            buildTextareaDom();
            adapter.discoverComposer();
        });

        it('reads text from textarea via .value', () => {
            const textarea = document.getElementById('mobile-composer-prompt') as HTMLTextAreaElement;
            textarea.value = 'hello world';
            expect(adapter.readComposerText()).toBe('hello world');
        });

        it('reads multiline text from textarea', () => {
            const textarea = document.getElementById('mobile-composer-prompt') as HTMLTextAreaElement;
            textarea.value = 'first line\nsecond line';
            expect(adapter.readComposerText()).toBe('first line\nsecond line');
        });

        it('writes neutral text to textarea and dispatches input event', () => {
            const textarea = document.getElementById('mobile-composer-prompt') as HTMLTextAreaElement;
            let inputFired = false;
            textarea.addEventListener('input', () => { inputFired = true; });

            adapter.writeComposerText('sanitized neutral replacement');

            expect(textarea.value).toBe('sanitized neutral replacement');
            expect(inputFired).toBe(true);
        });

        it('re-reading after write returns the written text', () => {
            adapter.writeComposerText('sanitized neutral replacement');
            expect(adapter.readComposerText()).toBe('sanitized neutral replacement');
        });
    });

    // ==========================================================================
    // CONTENTEDITABLE READ/WRITE TESTS
    // ==========================================================================
    describe('Contenteditable Read/Write', () => {

        beforeEach(() => {
            buildContenteditableDom();
            adapter.discoverComposer();
        });

        it('reads text from contenteditable via innerText', () => {
            const el = document.getElementById('prompt-textarea')!;
            el.textContent = 'hello world';
            expect(adapter.readComposerText()).toBe('hello world');
        });

        it('writes neutral text to contenteditable and dispatches input event', () => {
            const el = document.getElementById('prompt-textarea')!;
            let inputFired = false;
            el.addEventListener('input', () => { inputFired = true; });

            adapter.writeComposerText('sanitized neutral replacement');

            expect(el.textContent).toBe('sanitized neutral replacement');
            expect(inputFired).toBe(true);
        });

        it('re-reading after contenteditable write returns the written text', () => {
            adapter.writeComposerText('sanitized neutral replacement');
            expect(adapter.readComposerText()).toBe('sanitized neutral replacement');
        });
    });

    // ==========================================================================
    // KEYBOARD INTERCEPTION TESTS (TEXTAREA)
    // ==========================================================================
    describe('Keyboard Interception (textarea)', () => {
        let submitCount = 0;
        let lastSubmission: InterceptedSubmission | null = null;
        let composer: HTMLTextAreaElement;

        beforeEach(() => {
            submitCount = 0;
            lastSubmission = null;
            buildTextareaDom();
            adapter.discoverComposer();
            composer = document.getElementById('mobile-composer-prompt') as HTMLTextAreaElement;
            composer.value = 'test content';
            adapter.interceptSubmission((text, sub) => {
                submitCount++;
                lastSubmission = sub;
            });
        });

        it('intercepts plain Enter on textarea', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
            expect(event.defaultPrevented).toBe(true);
        });

        it('does not intercept Shift+Enter on textarea', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('does not intercept IME composition Enter on textarea', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('does not intercept Meta+Enter on textarea', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });
    });

    // ==========================================================================
    // KEYBOARD INTERCEPTION TESTS (CONTENTEDITABLE)
    // ==========================================================================
    describe('Keyboard Interception (contenteditable)', () => {
        let submitCount = 0;
        let composer: HTMLElement;

        beforeEach(() => {
            submitCount = 0;
            buildContenteditableDom();
            adapter.discoverComposer();
            composer = document.getElementById('prompt-textarea')!;
            composer.textContent = 'test content';
            adapter.interceptSubmission(() => { submitCount++; });
        });

        it('intercepts plain Enter on contenteditable', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
        });

        it('does not intercept Shift+Enter on contenteditable', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });
    });

    // ==========================================================================
    // SEND BUTTON INTERCEPTION TESTS
    // ==========================================================================
    describe('Send Button Interception', () => {
        it('intercepts click on recognized send button, ignores others', async () => {
            let submitCount = 0;
            document.body.innerHTML = `
                <main>
                    <textarea id="mobile-composer-prompt">test</textarea>
                    <button data-testid="send-button">Send</button>
                    <button id="other">Other</button>
                </main>
            `;
            adapter.discoverComposer();
            adapter.interceptSubmission(() => { submitCount++; });

            const sendBtn = document.querySelector('button[data-testid="send-button"]')!;
            const otherBtn = document.getElementById('other')!;

            const e1 = new MouseEvent('click', { cancelable: true });
            otherBtn.dispatchEvent(e1);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
            expect(e1.defaultPrevented).toBe(false);

            const e2 = new MouseEvent('click', { cancelable: true });
            sendBtn.dispatchEvent(e2);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
            expect(e2.defaultPrevented).toBe(true);
        });
    });

    // ==========================================================================
    // E. SPA REPLACEMENT / MUTATION OBSERVER TESTS
    // ==========================================================================
    describe('E. SPA Replacement / MutationObserver', () => {

        it('detects composer via MutationObserver after initial page load delay', async () => {
            vi.useFakeTimers();
            adapter.interceptSubmission(() => {});
            expect((adapter as any).composer).toBeNull();

            // Inject textarea composer into DOM (simulates SPA rendering it)
            buildTextareaDom();
            await Promise.resolve();
            vi.advanceTimersByTime(150);

            expect((adapter as any).composer).not.toBeNull();
            expect((adapter as any).state).toBe('Protected');
        });

        it('E. transitions state correctly on SPA composer replacement', async () => {
            vi.useFakeTimers();
            let submitCount = 0;
            adapter.interceptSubmission(() => { submitCount++; });

            // Composer A (textarea)
            document.body.innerHTML = `<main><textarea id="mobile-composer-prompt">A</textarea></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            const composerA = document.getElementById('mobile-composer-prompt')!;
            expect((adapter as any).state).toBe('Protected');

            // Composer A gets replaced by Composer B (SPA navigation)
            document.body.innerHTML = `<main><textarea id="mobile-composer-prompt">B</textarea></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            const composerB = document.getElementById('mobile-composer-prompt')!;

            vi.useRealTimers();

            // Event on stale detached A should not trigger
            composerA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));

            // Event on new B should trigger exactly once
            composerB.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            await new Promise(r => setTimeout(r, 0));

            expect(submitCount).toBe(1);
        });

        it('F. MutationObserver does not add duplicate listeners after repeated reconciliation', async () => {
            vi.useFakeTimers();
            let submitCount = 0;
            adapter.interceptSubmission(() => { submitCount++; });

            // First composer
            document.body.innerHTML = `<main><textarea id="mobile-composer-prompt">text</textarea></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);

            // Multiple rapid DOM changes (bursts)
            document.body.innerHTML = `<main><textarea id="mobile-composer-prompt">text2</textarea></main>`;
            await Promise.resolve();
            document.body.innerHTML = `<main><textarea id="mobile-composer-prompt">text3</textarea></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);

            const composer = document.getElementById('mobile-composer-prompt')!;
            vi.useRealTimers();

            // One Enter should fire exactly one submission
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
        });

        it('sets Degraded state when composer is detached and replacement not found', async () => {
            vi.useFakeTimers();
            adapter.interceptSubmission(() => {});

            // Set up initial composer
            document.body.innerHTML = `<main><textarea id="mobile-composer-prompt">text</textarea></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);
            expect((adapter as any).state).toBe('Protected');

            // Remove composer entirely — no replacement
            document.body.innerHTML = `<main><div>Loading...</div></main>`;
            await Promise.resolve();
            vi.advanceTimersByTime(150);

            // Adapter must NOT claim Protected
            expect((adapter as any).state).not.toBe('Protected');
        });

        it('cleans up observers on dispose', () => {
            adapter.interceptSubmission(() => {});
            expect((adapter as any).mutationObserver).not.toBeNull();
            adapter.dispose();
            expect((adapter as any).mutationObserver).toBeNull();
        });
    });

    // ==========================================================================
    // G. DISCOVERY FAILURE — SUPPORTED HOST, NO COMPOSER
    // ==========================================================================
    describe('G. Discovery failure on supported host', () => {
        it('returns NOT_FOUND when ChatGPT page has no recognized composer element', () => {
            // Simulates the live incident: supported host, no matching element
            document.body.innerHTML = `
                <main>
                    <div class="loading-spinner">Loading...</div>
                </main>
            `;
            const result = adapter.discoverComposer();
            expect(result).toBe('NOT_FOUND');
            // Adapter must NOT claim Protected
            expect((adapter as any).composer).toBeNull();
            expect((adapter as any).state).not.toBe('Protected');
        });
    });

    // ==========================================================================
    // ORIGINAL TESTS — PRESERVED
    // ==========================================================================
    describe('IME / Keyboard Tests (contenteditable)', () => {
        let submitCount = 0;
        let lastSubmission: InterceptedSubmission | null = null;
        let composer: HTMLElement;

        beforeEach(() => {
            submitCount = 0;
            document.body.innerHTML = `<main><div id="prompt-textarea" contenteditable="true">test content</div></main>`;
            adapter.discoverComposer();
            composer = document.getElementById('prompt-textarea')!;
            adapter.interceptSubmission((text, sub) => {
                submitCount++;
                lastSubmission = sub;
            });
        });

        it('should not intercept if isComposing is true', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('should not intercept Shift+Enter', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('should not intercept Meta+Enter', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(0);
        });

        it('should intercept plain Enter', async () => {
            const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));
            expect(submitCount).toBe(1);
            expect(event.defaultPrevented).toBe(true);
        });
    });

    describe('Re-entrancy & Duplicate Submission Tests', () => {
        let submissions: InterceptedSubmission[] = [];
        let composer: HTMLElement;

        beforeEach(() => {
            submissions = [];
            document.body.innerHTML = `<main><div id="prompt-textarea" contenteditable="true">test</div></main>`;
            adapter.discoverComposer();
            composer = document.getElementById('prompt-textarea')!;
            adapter.interceptSubmission((t, sub) => submissions.push(sub));
        });

        it('should have one active lifecycle on duplicate immediate Enter presses', async () => {
            const event1 = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
            const event2 = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });

            composer.dispatchEvent(event1);
            composer.dispatchEvent(event2);
            await new Promise(r => setTimeout(r, 0));

            expect(submissions.length).toBe(2);
            expect(event1.defaultPrevented).toBe(true);
            expect(event2.defaultPrevented).toBe(true);
        });

        it('should provide scoped one-shot resume authorization', async () => {
            let synthCount = 0;
            composer.addEventListener('keydown', (e) => {
                if (e.isTrusted === false && e.key === 'Enter') synthCount++;
            });

            const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
            composer.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 0));

            const sub = submissions[0];
            expect(sub).toBeDefined();

            await adapter.resumeSubmission(sub);
            expect(synthCount).toBe(1);

            // A brand new user submission should still be intercepted
            const event2 = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
            composer.dispatchEvent(event2);
            await new Promise(r => setTimeout(r, 0));

            expect(event2.defaultPrevented).toBe(true);
            expect(submissions.length).toBe(2);
        });
    });

    describe('Stale Decision Tests', () => {
        let submissions: InterceptedSubmission[] = [];

        beforeEach(() => {
            submissions = [];
            document.body.innerHTML = `<main><div id="prompt-textarea" contenteditable="true">A Content</div></main>`;
            adapter.discoverComposer();
            adapter.interceptSubmission((t, sub) => submissions.push(sub));
        });

        it('should discard ALLOW decision if content changed during inspection', async () => {
            const composer = document.getElementById('prompt-textarea')!;

            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
            await new Promise(r => setTimeout(r, 50));
            const sub = submissions[0];
            if (!sub) throw new Error("sub is undefined!");

            // Change content before decision arrives
            composer.textContent = "B Content";

            let synthCount = 0;
            composer.addEventListener('keydown', (e) => {
                if (e.isTrusted === false) synthCount++;
            });

            await adapter.resumeSubmission(sub);

            expect(synthCount).toBe(0);
            expect(sub.state).toBe('STOPPED');
        });
    });
});
