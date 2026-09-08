import { AiSiteAdapter, InterceptedSubmission, ProtectionState } from './types';

// WebCrypto helper for local, transient content hashing
async function hashContent(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export class ChatGPTAdapter implements AiSiteAdapter {
    private composer: HTMLElement | null = null;
    private sendButton: HTMLElement | null = null;
    private state: ProtectionState = "Initializing";
    private mutationObserver: MutationObserver | null = null;
    private onUserSubmitCb: ((text: string, submission: InterceptedSubmission) => void) | null = null;
    
    // Scoped one-shot bypass authorizations
    private authorizedBypasses: Set<string> = new Set();
    
    // Internal counters for request ids
    private submissionCounter = 0;

    // Listeners for cleanup
    private keydownListener: (e: KeyboardEvent) => void = this.handleKeydown.bind(this);
    private clickListener: (e: MouseEvent) => void = this.handleClick.bind(this);

    serviceId(): string {
        return "chatgpt";
    }

    matchesCurrentPage(): boolean {
        return window.location.hostname === "chatgpt.com";
    }

    discoverComposer(): "FOUND" | "NOT_FOUND" | "DEGRADED" {
        // Implementation heuristic: Ordered strategy for finding composer
        
        // 1. Try known selector heuristic (#prompt-textarea) combined with role/semantics
        let candidate = document.querySelector('#prompt-textarea') as HTMLElement;
        
        if (!candidate) {
            // 2. Try generic contenteditable editor inside a likely main region
            const contentEditables = document.querySelectorAll('main [contenteditable="true"], form [contenteditable="true"]');
            if (contentEditables.length === 1) {
                candidate = contentEditables[0] as HTMLElement;
            }
        }

        if (candidate) {
            this.composer = candidate;
            
            // Try to find the send button. Usually it is a button near the composer, or has a specific data-testid
            // For now, look for a button that is a sibling or uncle with aria-label="Send prompt"
            // or data-testid="send-button"
            const sendBtnCandidate = document.querySelector('button[data-testid="send-button"]') as HTMLElement;
            this.sendButton = sendBtnCandidate || null; // Might be null, we'll still protect keyboard
            
            return "FOUND";
        }

        return "NOT_FOUND";
    }

    readComposerText(): string {
        if (!this.composer) return "";
        return this.composer.innerText || this.composer.textContent || "";
    }

    writeComposerText(text: string): void {
        if (!this.composer) return;
        // In React/Draft.js or similar, simply setting innerText might not trigger React state.
        // For standard contenteditable, we can try replacing text content.
        // It's a heuristic. Dispatching input event is usually needed.
        this.composer.textContent = text;
        this.composer.dispatchEvent(new Event('input', { bubbles: true }));
    }

    interceptSubmission(onUserSubmit: (text: string, submission: InterceptedSubmission) => void): void {
        this.onUserSubmitCb = onUserSubmit;
        this.bindListeners();
        this.setupMutationObserver();
    }

    private bindListeners(): void {
        if (this.composer) {
            this.composer.addEventListener('keydown', this.keydownListener, true); // capture phase
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

        let debounceTimeout: any = null;

        this.mutationObserver = new MutationObserver(() => {
            if (debounceTimeout) clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => {
                this.reconcileDom();
            }, 100);
        });

        this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    private reconcileDom(): void {
        // If current composer is still connected, don't do anything
        if (this.composer && document.body.contains(this.composer)) {
            return;
        }

        this.unbindListeners();
        this.composer = null;
        this.sendButton = null;

        const result = this.discoverComposer();
        if (result === "FOUND") {
            this.bindListeners();
            if (this.state !== "Disconnected") {
                this.setProtectionState("Protected");
            }
        } else if (result === "NOT_FOUND" || result === "DEGRADED") {
            if (this.state !== "Disconnected") {
                this.setProtectionState("Degraded");
            }
        }
    }

    private async handleKeydown(e: KeyboardEvent) {
        console.log("handleKeydown fired:", e.key, e.isComposing, e.keyCode, "isResumingFlag:", this.isResumingFlag);
        // Ignore IME composition
        if (e.isComposing || e.keyCode === 229) return;
        
        // Intercept Enter without Shift (or other modifiers)
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (this.isResumingFlag) return; // Synchronous bypass for our own synthetic event
            e.preventDefault();
            e.stopImmediatePropagation();
            await this.processSubmissionEvent("keyboard");
        }
    }

    private async handleClick(e: MouseEvent) {
        if (this.isResumingFlag) return; // Synchronous bypass
        e.preventDefault();
        e.stopImmediatePropagation();
        await this.processSubmissionEvent("button");
    }

    private async processSubmissionEvent(trigger: string) {
        try {
            console.log("processSubmissionEvent trigger:", trigger);
            const text = this.readComposerText().trim();
            console.log("text read:", text);
            if (!text) return; // Empty submission, ignore

            console.log("hashing text...");
            const currentHash = await hashContent(text);
            console.log("hashed text:", currentHash);
            
            this.submissionCounter++;
            const submissionId = `sub_${Date.now()}_${this.submissionCounter}`;

            const submission: InterceptedSubmission = {
                id: submissionId,
                contentVersion: currentHash,
                trigger,
                state: "PAUSED"
            };

            if (this.onUserSubmitCb) {
                this.onUserSubmitCb(text, submission);
            }
        } catch (err) {
            console.error("Error in processSubmissionEvent:", err);
        }
    }

    private isResumingFlag: boolean = false;

    async resumeSubmission(submission: InterceptedSubmission, skipHashCheck: boolean = false): Promise<void> {
        if (submission.state !== "PAUSED") return;

        const currentText = this.readComposerText().trim();
        const currentHash = await hashContent(currentText);

        if (!skipHashCheck && currentHash !== submission.contentVersion) {
            // Stale content! Reject.
            console.warn("ShadowShield: Composer content changed during inspection. Decision discarded.");
            submission.state = "STOPPED";
            return;
        }

        // Authorize this specific content hash for one-shot bypass
        if (this.authorizedBypasses.has(currentHash)) {
            // Already authorized/resumed recently
            return;
        }
        this.authorizedBypasses.add(currentHash);
        
        // Consume bypass authorization immediately
        this.authorizedBypasses.delete(currentHash);

        submission.state = "RESUMED";

        // Dispatch synthetic event synchronously
        this.isResumingFlag = true;
        this.dispatchSyntheticSubmission(submission.trigger);
        this.isResumingFlag = false;
    }

    stopSubmission(submission: InterceptedSubmission): void {
        submission.state = "STOPPED";
    }

    private dispatchSyntheticSubmission(trigger: string) {
        if (trigger === "keyboard" && this.composer) {
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            });
            this.composer.dispatchEvent(enterEvent);
        } else if (trigger === "button" && this.sendButton) {
            const clickEvent = new MouseEvent('click', {
                bubbles: true,
                cancelable: true
            });
            this.sendButton.dispatchEvent(clickEvent);
        }
    }

    setProtectionState(state: ProtectionState): void {
        this.state = state;
        // The content script will update UI based on this if needed
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
