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
        this.container.style.bottom = '20px';
        this.container.style.right = '20px';
        this.container.style.zIndex = '999999';

        this.shadowRoot = this.container.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            .shield-banner {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                background: #1a1a1a;
                color: #ffffff;
                padding: 16px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                border: 1px solid #333;
                max-width: 320px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .shield-title {
                font-weight: 600;
                font-size: 14px;
                margin: 0;
            }
            .shield-message {
                font-size: 13px;
                line-height: 1.4;
                margin: 0;
                color: #ccc;
            }
            .shield-actions {
                display: flex;
                gap: 8px;
                justify-content: flex-end;
            }
            button {
                background: #333;
                color: white;
                border: 1px solid #444;
                padding: 6px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
            }
            button.primary {
                background: #0066cc;
                border-color: #0055aa;
            }
            button:hover {
                background: #444;
            }
            button.primary:hover {
                background: #0055aa;
            }
            .degraded {
                background: #fff3cd;
                color: #856404;
                border-color: #ffeeba;
            }
            .degraded .shield-message {
                color: #856404;
            }
            .blocked {
                border-top: 4px solid #dc3545;
            }
            .coach {
                border-top: 4px solid #ffc107;
            }
            .redacted {
                border-top: 4px solid #28a745;
            }
            .disconnected {
                border-top: 4px solid #6c757d;
            }
        `;
        this.shadowRoot.appendChild(style);

        document.body.appendChild(this.container);
    }

    // -------------------------------------------------------------------------
    // Coach — two distinct methods for accurate provenance
    // -------------------------------------------------------------------------

    /**
     * AI Access Coach — shown when the AI governance layer has flagged the
     * service as unreviewed or not approved by policy.
     *
     * DLP has NOT run at this point. Must NOT claim sensitive data was detected.
     *
     * Cancel → stopSubmission (caller's responsibility)
     * Proceed → caller runs DLP inspection
     */
    public showAiAccessCoach(
        callbacks: { onCancel: () => void; onProceed: () => void }
    ): void {
        this._showCoachBanner(
            "AI Service Review",
            "This AI service has not been approved by your organization's policy. Review before continuing.",
            callbacks
        );
    }

    /**
     * Data Protection Coach — shown when DLP inspection has identified a
     * potential policy concern in the submitted content.
     *
     * DLP HAS run at this point. May accurately reference content review.
     *
     * Cancel → stopSubmission (caller's responsibility)
     * Proceed → resumeSubmission exactly once (caller's responsibility)
     */
    public showDataProtectionCoach(
        callbacks: { onCancel: () => void; onProceed: () => void }
    ): void {
        this._showCoachBanner(
            "Sensitive Information Detected",
            "ShadowShield detected potentially sensitive information in this request. Review before continuing.",
            callbacks
        );
    }

    /**
     * Show a non-coach enforcement state.
     * Coach states must use showAiAccessCoach() or showDataProtectionCoach().
     */
    public showState(
        state: UiState
    ): void {
        this._clearBanner();

        if (state === "None") return;

        const banner = document.createElement('div');
        banner.className = `shield-banner ${state.toLowerCase()}`;

        let title = "ShadowShield";
        let message = "";

        switch (state) {
            case "Blocked":
                title = "Submission Blocked";
                message = "ShadowShield blocked this request based on your organization's policy.";
                break;
            case "Redacted":
                title = "Data Redacted";
                message = "Sensitive information was redacted before submission.";
                setTimeout(() => this.showState("None"), 4000);
                break;
            case "Disconnected":
                title = "Agent Disconnected";
                message = "ShadowShield protection is unavailable. Reconnect the agent before sending.";
                break;
            case "Degraded":
                title = "Protection Degraded";
                message = "ShadowShield is running but could not hook the composer reliably.";
                break;
        }

        banner.innerHTML = `
            <div class="shield-title">${title}</div>
            <div class="shield-message">${message}</div>
        `;

        this.shadowRoot.appendChild(banner);
    }

    public dispose(): void {
        if (this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    private _clearBanner(): void {
        const existing = this.shadowRoot.querySelector('.shield-banner');
        if (existing) existing.remove();
    }

    private _showCoachBanner(
        title: string,
        message: string,
        callbacks: { onCancel: () => void; onProceed: () => void }
    ): void {
        this._clearBanner();

        const banner = document.createElement('div');
        banner.className = 'shield-banner coach';

        banner.innerHTML = `
            <div class="shield-title">${title}</div>
            <div class="shield-message">${message}</div>
            <div class="shield-actions"></div>
        `;

        const actions = banner.querySelector('.shield-actions')!;

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => {
            this._clearBanner();
            callbacks.onCancel();
        };

        const proceedBtn = document.createElement('button');
        proceedBtn.className = 'primary';
        proceedBtn.textContent = 'Proceed';
        proceedBtn.onclick = () => {
            this._clearBanner();
            callbacks.onProceed();
        };

        actions.appendChild(cancelBtn);
        actions.appendChild(proceedBtn);

        this.shadowRoot.appendChild(banner);
    }
}
