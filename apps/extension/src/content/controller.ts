/**
 * EnforcementController — shared enforcement lifecycle for all ShadowShield site adapters.
 *
 * Responsibilities:
 *   - Iterative composer discovery (with Degraded-after-threshold logic)
 *   - Enforcement flow: EvaluateAiAccess -> Inspect -> Allow/Coach/Redact/Block
 *   - Native Messaging via background service-worker
 *   - Disconnect detection and fail-closed behavior
 *   - EnforcementUi state management
 *
 * NOT responsible for:
 *   - Which selectors to use (adapter's job)
 *   - Risk scoring, DLP detection, policy mapping (Rust native host's job)
 *   - Service IDs (adapter's job)
 */

import { AiSiteAdapter } from '../adapters/types';
import { EnforcementUi } from '../enforcement/ui';
import { ExtensionMessageEnvelope, InspectMessage, EvaluateAiAccessMessage } from '../native/messages';

// After this many consecutive NOT_FOUND cycles, show Degraded.
// At 3 seconds per cycle, 4 cycles = 12 seconds.
const DEGRADED_AFTER_CYCLES = 4;

export class EnforcementController {
    private readonly adapter: AiSiteAdapter;
    private readonly ui: EnforcementUi;

    private hasProtected = false;
    private notFoundCycles = 0;
    private isDisconnected = false;
    private discoveryInterval: ReturnType<typeof setInterval> | null = null;

    constructor(adapter: AiSiteAdapter, ui: EnforcementUi) {
        this.adapter = adapter;
        this.ui = ui;
    }

    /**
     * Start the discovery poll and enforcement lifecycle.
     * Idempotent: safe to call multiple times (only starts once).
     */
    public start(): void {
        if (this.discoveryInterval !== null) return;

        this.discoveryInterval = setInterval(() => {
            if (this.hasProtected) {
                this.stopDiscovery();
                return;
            }

            if (!this.isDisconnected) {
                const result = this.adapter.discoverComposer();

                if (result === 'FOUND') {
                    this.hasProtected = true;
                    this.notFoundCycles = 0;
                    this.adapter.setProtectionState('Protected');
                    this.adapter.interceptSubmission(this.handleUserSubmit.bind(this));
                    this.ui.showState('None');
                    this.stopDiscovery();
                } else if (result === 'DEGRADED') {
                    this.notFoundCycles = 0;
                    this.ui.showState('Degraded');
                } else {
                    this.notFoundCycles++;
                    if (this.notFoundCycles >= DEGRADED_AFTER_CYCLES) {
                        this.ui.showState('Degraded');
                    }
                }
            }
        }, 3000);
    }

    public dispose(): void {
        this.stopDiscovery();
        this.adapter.dispose();
    }

    private stopDiscovery(): void {
        if (this.discoveryInterval !== null) {
            clearInterval(this.discoveryInterval);
            this.discoveryInterval = null;
        }
    }

    // -------------------------------------------------------------------------
    // Native Messaging
    // -------------------------------------------------------------------------

    private async sendMessageToBackground(payload: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const envelope: ExtensionMessageEnvelope = {
                shadowshield: true,
                request_id: `req_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                payload
            };

            chrome.runtime.sendMessage(envelope, (response) => {
                if (chrome.runtime.lastError) {
                    this.isDisconnected = true;
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (!response || !response.success) {
                    const err = response?.error || 'Unknown error';
                    if (err.includes('disconnected') || err.includes('connection')) {
                        this.isDisconnected = true;
                    }
                    return reject(new Error(err));
                }
                this.isDisconnected = false;
                resolve(response.response);
            });
        });
    }

    // -------------------------------------------------------------------------
    // Enforcement flow
    // -------------------------------------------------------------------------

    private async handleUserSubmit(text: string, submission: any): Promise<void> {
        const adapter = this.adapter;
        const ui = this.ui;

        const runDlpInspection = async () => {
            const inspectReq: InspectMessage = {
                type: 'Inspect',
                source: 'browser_extension',
                ai_service: adapter.serviceId(),
                content: text,
                timestamp: Date.now()
            };

            const inspectResp = await this.sendMessageToBackground(inspectReq);

            switch (inspectResp.action) {
                case 'Allow':
                    adapter.resumeSubmission(submission);
                    break;
                case 'Block':
                    adapter.stopSubmission(submission);
                    ui.showState('Blocked');
                    break;
                case 'Coach':
                    ui.showState('Coach', {
                        onCancel: () => adapter.stopSubmission(submission),
                        onProceed: () => adapter.resumeSubmission(submission)
                    });
                    break;
                case 'Redact':
                    if (inspectResp.sanitized_content) {
                        adapter.writeComposerText(inspectResp.sanitized_content);
                        const verifiedText = adapter.readComposerText();
                        if (verifiedText === inspectResp.sanitized_content) {
                            adapter.resumeSubmission(submission, true);
                            ui.showState('Redacted');
                        } else {
                            adapter.stopSubmission(submission);
                            ui.showState('Degraded');
                        }
                    } else {
                        adapter.stopSubmission(submission);
                        ui.showState('Blocked');
                    }
                    break;
                default:
                    adapter.stopSubmission(submission);
                    ui.showState('Blocked');
                    break;
            }
        };

        try {
            const accessReq: EvaluateAiAccessMessage = {
                type: 'EvaluateAiAccess',
                service_id: adapter.serviceId(),
                mode: 'Policy'
            };

            const accessResp = await this.sendMessageToBackground(accessReq);

            if (accessResp.decision === 'Block') {
                adapter.stopSubmission(submission);
                ui.showState('Blocked');
                return;
            }

            if (accessResp.decision === 'Coach') {
                ui.showState('Coach', {
                    onCancel: () => adapter.stopSubmission(submission),
                    onProceed: () => runDlpInspection()
                });
                return;
            }

            await runDlpInspection();
        } catch (e: any) {
            console.warn('ShadowShield Request failed:', e.message);
            adapter.stopSubmission(submission);
            if (
                this.isDisconnected ||
                e.message.includes('disconnected') ||
                e.message.includes('establish connection')
            ) {
                ui.showState('Disconnected');
            } else {
                ui.showState('Blocked');
            }
        }
    }
}
