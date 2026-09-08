export type UiState = "None" | "Coach" | "Blocked" | "Redacted" | "Disconnected" | "Degraded";

export class EnforcementUi {
    private container: HTMLElement;
    private shadowRoot: ShadowRoot;

    constructor() {
        this.container = document.createElement('div');
        // Place it somewhere it won't break layout. 
        // e.g., fixed bottom, so it floats.
        this.container.style.position = 'fixed';
        this.container.style.bottom = '20px';
        this.container.style.right = '20px';
        this.container.style.zIndex = '999999';
        
        this.shadowRoot = this.container.attachShadow({ mode: 'open' });
        
        // Initial styles
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

    public showState(
        state: UiState, 
        callbacks?: { onProceed?: () => void, onCancel?: () => void }
    ) {
        console.log("ui.showState called with:", state);
        // Clear existing
        const existing = this.shadowRoot.querySelector('.shield-banner');
        if (existing) {
            existing.remove();
        }

        if (state === "None") return;

        const banner = document.createElement('div');
        banner.className = `shield-banner ${state.toLowerCase()}`;

        let title = "ShadowShield";
        let message = "";
        let showActions = false;

        switch (state) {
            case "Blocked":
                title = "Submission Blocked";
                message = "ShadowShield blocked this request because it contains sensitive information.";
                break;
            case "Coach":
                title = "Security Review";
                message = "ShadowShield detected potentially sensitive information.";
                showActions = true;
                break;
            case "Redacted":
                title = "Data Redacted";
                message = "Sensitive information was redacted before submission.";
                setTimeout(() => this.showState("None"), 4000); // auto-hide
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
            ${showActions ? '<div class="shield-actions"></div>' : ''}
        `;

        if (showActions) {
            const actions = banner.querySelector('.shield-actions')!;
            
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = () => {
                this.showState("None");
                if (callbacks?.onCancel) callbacks.onCancel();
            };

            const proceedBtn = document.createElement('button');
            proceedBtn.className = 'primary';
            proceedBtn.textContent = 'Proceed';
            proceedBtn.onclick = () => {
                this.showState("None");
                if (callbacks?.onProceed) callbacks.onProceed();
            };

            actions.appendChild(cancelBtn);
            actions.appendChild(proceedBtn);
        }

        this.shadowRoot.appendChild(banner);
        console.log("ui.showState appended banner. Shadow DOM HTML:", this.shadowRoot.innerHTML);
    }

    public dispose() {
        if (this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}
