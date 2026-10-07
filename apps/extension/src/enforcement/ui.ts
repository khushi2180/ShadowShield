/**
 * CoachReason distinguishes the source of a Coach decision so that the UI
 * can display accurate, provenance-correct wording.
 *
 * AiAccess — the AI governance layer flagged the service as unreviewed/unknown.
 *   DLP has NOT run yet. The UI must NOT claim sensitive data was detected.
 *
 * DataProtection — the DLP inspection layer identified a potential policy
 *   concern. The UI may accurately reference content review.
 */
export type CoachReason = "AiAccess" | "DataProtection";

export type UiState =
    | "None"
    | "Blocked"
    | "Redacted"
    | "Disconnected"
    | "Degraded";

/**
 * EnforcementUi — renders privacy-safe enforcement banners in a Shadow DOM.
 *
 * Coach is exposed as two distinct methods to enforce provenance at the
 * call site (type-checked, not string-checked):
 *
 *   showAiAccessCoach(callbacks)   — AI governance review, no DLP wording
 *   showDataProtectionCoach(callbacks) — DLP review, sensitive-data wording
 *
 * Privacy invariants:
 *   - No banner text contains prompt content, hashes, or detection values.
 *   - No console.log/console.error calls emit content or IPC payloads.
 */
export class EnforcementUi {
    private container: HTMLElement;
    private shadowRoot: ShadowRoot;

    constructor() {
        this.container = document.createElement('div');
        this.container.style.position = 'fixed';
        this.container.style.bottom = '24px';
        this.container.style.right = '24px';
        this.container.style.zIndex = '999999';

        this.shadowRoot = this.container.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from { transform: translateY(16px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            .shield-banner {
                font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                background: #1e1e1e;
                color: #f3f4f6;
                padding: 16px;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.4);
                border: 1px solid #374151;
                width: 320px;
                max-width: calc(100vw - 48px);
                display: flex;
                flex-direction: column;
                gap: 12px;
                animation: slideIn 0.2s ease-out;
            }
            @media (prefers-reduced-motion: reduce) {
                .shield-banner {
                    animation: none;
                }
            }
            .shield-header {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .shield-icon {
                width: 16px;
                height: 16px;
                fill: currentColor;
            }
            .shield-title {
                font-weight: 600;
                font-size: 14px;
                margin: 0;
                color: #f9fafb;
            }
            .shield-message {
                font-size: 13px;
                line-height: 1.4;
                margin: 0;
                color: #d1d5db;
            }
            .shield-status {
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                padding: 4px 8px;
                border-radius: 4px;
                display: inline-block;
                align-self: flex-start;
                margin-top: 4px;
            }
            .shield-actions {
                display: flex;
                gap: 8px;
                justify-content: flex-end;
                margin-top: 4px;
            }
            button {
                background: #374151;
                color: #f9fafb;
                border: 1px solid #4b5563;
                padding: 6px 14px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: background 0.15s;
            }
            button:hover, button:focus-visible {
                background: #4b5563;
                outline: 2px solid #60a5fa;
                outline-offset: 2px;
            }
            button.primary {
                background: #2563eb;
                border-color: #1d4ed8;
            }
            button.primary:hover, button.primary:focus-visible {
                background: #1d4ed8;
            }

            /* Theme variations */
            .degraded .shield-title, .degraded .shield-icon { color: #f59e0b; }

            .blocked { border-left: 4px solid #ef4444; border-top: 1px solid #374151; }
            .blocked .shield-title, .blocked .shield-icon { color: #ef4444; }
            .blocked .shield-status { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }

            .coach { border-left: 4px solid #f59e0b; border-top: 1px solid #374151; }
            .coach .shield-title, .coach .shield-icon { color: #f59e0b; }

            .redacted { border-left: 4px solid #10b981; border-top: 1px solid #374151; }
            .redacted .shield-title, .redacted .shield-icon { color: #10b981; }
            .redacted .shield-status { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; }

            .disconnected .shield-title, .disconnected .shield-icon { color: #9ca3af; }
        `;
        this.shadowRoot.appendChild(style);
        document.body.appendChild(this.container);
    }

    private getShieldIcon(): string {
        return `<svg class="shield-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
    }

    public showAiAccessCoach(
        callbacks: { onCancel: () => void; onProceed: () => void }
    ): void {
        this._showBanner({
            theme: 'coach',
            title: 'AI Service Review',
            message: "This AI service requires review under your organization's policy.",
            buttons: [
                { label: 'Cancel', primary: false, onClick: callbacks.onCancel },
                { label: 'Proceed', primary: true, onClick: callbacks.onProceed }
            ]
        });
    }

    public showDataProtectionCoach(
        callbacks: { onCancel: () => void; onProceed: () => void }
    ): void {
        this._showBanner({
            theme: 'coach',
            title: 'Sensitive Information Detected',
            message: 'ShadowShield detected potentially sensitive information in this request. Review before continuing.',
            buttons: [
                { label: 'Cancel', primary: false, onClick: callbacks.onCancel },
                { label: 'Proceed', primary: true, onClick: callbacks.onProceed }
            ]
        });
    }

    public showState(state: UiState): void {
        this._clearBanner();
        if (state === "None") return;

        let title = "ShadowShield";
        let message = "";
        let status = "";
        let timeout = 0;

        switch (state) {
            case "Blocked":
                title = "Submission Blocked";
                message = "ShadowShield blocked this request based on your organization's policy.";
                status = "Action: BLOCKED";
                break;
            case "Redacted":
                title = "Data Redacted";
                message = "Sensitive information was removed before this request was sent.";
                status = "Action: REDACTED";
                timeout = 5000;
                break;
            case "Disconnected":
                title = "Agent Disconnected";
                message = "ShadowShield protection is unavailable. Reconnect the agent before sending.";
                break;
            case "Degraded":
                title = "Protection Degraded";
                message = "ShadowShield could not verify protection for this AI input.";
                break;
        }

        this._showBanner({
            theme: state.toLowerCase(),
            title,
            message,
            status,
            buttons: []
        });

        if (timeout > 0) {
            setTimeout(() => this.showState("None"), timeout);
        }
    }

    public dispose(): void {
        if (this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }

    private _clearBanner(): void {
        const existing = this.shadowRoot.querySelector('.shield-banner');
        if (existing) existing.remove();
    }

    private _showBanner(opts: {
        theme: string;
        title: string;
        message: string;
        status?: string;
        buttons: Array<{label: string, primary: boolean, onClick: () => void}>;
    }): void {
        this._clearBanner();

        const banner = document.createElement('div');
        banner.className = `shield-banner ${opts.theme}`;
        banner.setAttribute('role', 'alert');

        let innerHTML = `
            <div class="shield-header">
                ${this.getShieldIcon()}
                <div class="shield-title">${opts.title}</div>
            </div>
            <div class="shield-message">${opts.message}</div>
        `;

        if (opts.status) {
            innerHTML += `<div class="shield-status">${opts.status}</div>`;
        }

        if (opts.buttons.length > 0) {
            innerHTML += `<div class="shield-actions"></div>`;
        }

        banner.innerHTML = innerHTML;

        if (opts.buttons.length > 0) {
            const actions = banner.querySelector('.shield-actions')!;
            opts.buttons.forEach(b => {
                const btn = document.createElement('button');
                btn.textContent = b.label;
                if (b.primary) btn.className = 'primary';
                btn.onclick = () => {
                    this._clearBanner();
                    b.onClick();
                };
                actions.appendChild(btn);
            });
        }

        this.shadowRoot.appendChild(banner);
    }
}
