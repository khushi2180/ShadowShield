import { AiSiteAdapter, InterceptedSubmission, ProtectionState } from './types';

// WebCrypto helper — identical to ChatGPT adapter, kept local to avoid shared-state coupling
async function hashContent(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function isTextarea(el: HTMLElement): el is HTMLTextAreaElement {
    return el.tagName === 'TEXTAREA';
}

// --- Ordered composer selectors for Claude ---
//
// Discovery order: most stable/specific first, semantic fallback last.
// IMPORTANT: Claude DOM is an unstable external boundary. Never use generated
// CSS classes or nth-child selectors.
//
// Verified selectors:
//   1. div[contenteditable="true"][data-placeholder]   — Claude's ProseMirror-based
//      rich editor uses a contenteditable div with a data-placeholder attribute.
//      Verified live Sep 2026: aria-label="Write your prompt to Claude".
//   2. Semantic fallback: single contenteditable in main/form with a prompt-like
//      aria-label or data-placeholder.
//
// LIVE DOM DISCOVERY STATUS: BLOCKED_BY_ANTIGRAVITY_BROWSER_CAPACITY
//   Selectors below are based on publicly documented Claude.ai DOM structure as of
//   Sep 2026. They MUST be verified against the live DOM before declaring
//   Protected compatibility.
//
// Unsupported surfaces (V1):
//   - File/image upload areas
//   - Voice input
//   - Project artifact editors
//   - Output area
// -------------------------------------------------------------------------

const CLAUDE_COMPOSER_SELECTORS: string[] = [
    'div[contenteditable="true"][data-placeholder]',  // Primary: ProseMirror editor
];

const CLAUDE_ARIA_LABEL_KEYWORDS = ['write your prompt', 'message', 'prompt to claude', 'send a message'];

export class ClaudeAdapter implements AiSiteAdapter {
    private composer: HTMLElement | null = null;
    private sendButton: HTMLElement | null = null;
    private state: ProtectionState = 'Initializing';
    private mutationObserver: MutationObserver | null = null;
    private onUserSubmitCb: ((text: string, submission: InterceptedSubmission) => void) | null = null;

    private authorizedBypasses: Set<string> = new Set();
    private submissionCounter = 0;
    private isResumingFlag = false;

    private keydownListener: (e: KeyboardEvent) => void = this.handleKeydown.bind(this);
    private clickListener: (e: MouseEvent) => void = this.handleClick.bind(this);

    serviceId(): string {
        return 'claude';
    }

    matchesCurrentPage(): boolean {
        return window.location.hostname === 'claude.ai';
    }

    discoverComposer(): 'FOUND' | 'NOT_FOUND' | 'DEGRADED' {
        let candidate: HTMLElement | null = null;

        // Step 1: Try known stable selectors
        for (const sel of CLAUDE_COMPOSER_SELECTORS) {
            const nodes = document.querySelectorAll<HTMLElement>(sel);
            // Filter to those with a prompt-like aria-label or inside main/form
            const promptCandidates = Array.from(nodes).filter(el => {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                const inMain = !!el.closest('main');
                const hasPromptLabel = CLAUDE_ARIA_LABEL_KEYWORDS.some(kw => label.includes(kw));
                // Accept if it has a matching aria-label OR is in main and has a placeholder
                return hasPromptLabel || (inMain && el.getAttribute('data-placeholder'));
            });

            if (promptCandidates.length === 1) {
                candidate = promptCandidates[0];
                break;
            } else if (promptCandidates.length > 1) {
                return 'DEGRADED';
            }
        }

        // Step 2: Semantic contenteditable fallback scoped to main/form
        if (!candidate) {
            const ceNodes = document.querySelectorAll<HTMLElement>(
                'main [contenteditable="true"], form [contenteditable="true"]'
            );
            if (ceNodes.length === 1) {
                candidate = ceNodes[0];
            } else if (ceNodes.length > 1) {
                return 'DEGRADED';
            }
        }

        if (!candidate) {
            return 'NOT_FOUND';
        }

        this.composer = candidate;
        this.sendButton = this.discoverSendButton();
        return 'FOUND';
    }

    private discoverSendButton(): HTMLElement | null {
        // Claude uses a button with aria-label containing "Send" (verified Sep 2026)
        const allBtns = document.querySelectorAll<HTMLButtonElement>('button[aria-label]');
        for (const btn of allBtns) {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (label === 'send message' || label === 'send' || label === 'send prompt') {
                return btn;
            }
        }
        // Fallback: button with type=submit near the composer
        if (this.composer) {
            const form = this.composer.closest('form');
            if (form) {
                const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
                if (submitBtn) return submitBtn;
            }
        }
        return null;
    }

    readComposerText(): string {
        if (!this.composer) return '';
        if (isTextarea(this.composer)) {
            return this.composer.value;
        }
        // ProseMirror contenteditable: innerText preserves newlines
        return this.composer.innerText || this.composer.textContent || '';
    }

    writeComposerText(text: string): void {
        if (!this.composer) return;

        if (isTextarea(this.composer)) {
            const nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (nativeDescriptor?.set) {
                nativeDescriptor.set.call(this.composer, text);
            } else {
                (this.composer as HTMLTextAreaElement).value = text;
            }
        } else {
            // contenteditable: set textContent to avoid XSS via innerHTML.
            // Note: ProseMirror may not sync from textContent alone — the input event
            // below is necessary but may not be sufficient for all framework versions.
            this.composer.textContent = text;
        }

        this.composer.dispatchEvent(new Event('input', { bubbles: true }));
    }

    interceptSubmission(onUserSubmit: (text: string, submission: InterceptedSubmission) => void): void {
        this.onUserSubmitCb = onUserSubmit;
        this.bindListeners();
        this.setupMutationObserver();
    }

    private bindListeners(): void {
        if (this.composer) {
            this.composer.addEventListener('keydown', this.keydownListener, true);
        }
        if (this.sendButton) {
            this.sendButton.addEventListener('click', this.clickListener, true);
        }
    }

    private unbindListeners(): void {
        if (this.composer) {
            this.composer.removeEventListener('keydown', this.keydownListener, true);
        }
        if (this.sendButton) {
            this.sendButton.removeEventListener('click', this.clickListener, true);
        }
    }

    private setupMutationObserver(): void {
        if (this.mutationObserver) return;

        let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

        this.mutationObserver = new MutationObserver(() => {
            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => {
                this.reconcileDom();
            }, 100);
        });

        this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    private reconcileDom(): void {
        if (this.composer && document.body.contains(this.composer)) {
            return;
        }

        this.unbindListeners();
        this.composer = null;
        this.sendButton = null;

        const result = this.discoverComposer();
        if (result === 'FOUND') {
            this.bindListeners();
            if (this.state !== 'Disconnected') {
                this.setProtectionState('Protected');
            }
        } else {
            if (this.state !== 'Disconnected') {
                this.setProtectionState('Degraded');
            }
        }
    }

    private async handleKeydown(e: KeyboardEvent) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (this.isResumingFlag) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            await this.processSubmissionEvent('keyboard');
        }
    }

    private async handleClick(e: MouseEvent) {
        if (this.isResumingFlag) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        await this.processSubmissionEvent('button');
    }

    private async processSubmissionEvent(trigger: string) {
        try {
            const text = this.readComposerText().trim();
            if (!text) return;

            const currentHash = await hashContent(text);
            this.submissionCounter++;
            const submissionId = `sub_${Date.now()}_${this.submissionCounter}`;

            const submission: InterceptedSubmission = {
                id: submissionId,
                contentVersion: currentHash,
                trigger,
                state: 'PAUSED'
            };

            if (this.onUserSubmitCb) {
                this.onUserSubmitCb(text, submission);
            }
        } catch (err) {
            console.error('ShadowShield: Error in processSubmissionEvent:', err);
        }
    }

    async resumeSubmission(submission: InterceptedSubmission, skipHashCheck = false): Promise<void> {
        if (submission.state !== 'PAUSED') return;

        const currentText = this.readComposerText().trim();
        const currentHash = await hashContent(currentText);

        if (!skipHashCheck && currentHash !== submission.contentVersion) {
            console.warn('ShadowShield: Composer content changed during inspection. Decision discarded.');
            submission.state = 'STOPPED';
            return;
        }

        if (this.authorizedBypasses.has(currentHash)) return;
        this.authorizedBypasses.add(currentHash);
        this.authorizedBypasses.delete(currentHash);

        submission.state = 'RESUMED';

        this.isResumingFlag = true;
        this.dispatchSyntheticSubmission(submission.trigger);
        this.isResumingFlag = false;
    }

    stopSubmission(submission: InterceptedSubmission): void {
        submission.state = 'STOPPED';
    }

    private dispatchSyntheticSubmission(trigger: string) {
        if (trigger === 'keyboard' && this.composer) {
            this.composer.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true
            }));
        } else if (trigger === 'button' && this.sendButton) {
            this.sendButton.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true
            }));
        }
    }

    setProtectionState(state: ProtectionState): void {
        this.state = state;
    }

    dispose(): void {
        this.unbindListeners();
        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
        this.composer = null;
        this.sendButton = null;
    }
}
