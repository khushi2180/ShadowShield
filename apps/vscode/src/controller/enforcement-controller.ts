import { IIpcClient } from '../ipc/client-interface';
import { BannerState, DispatchTicket, TicketState } from './types';
import { hashContent } from '../util/crypto';

export class VsCodeEnforcementController {
    private client: IIpcClient;
    private ticketCounter = 0;
    private activeTicket: DispatchTicket | null = null;
    private currentBanner: BannerState = { type: 'None' };
    private isInspecting = false;

    constructor(client: IIpcClient) {
        this.client = client;
    }

    public getClient(): IIpcClient {
        return this.client;
    }

    public setClient(client: IIpcClient): void {
        this.client = client;
    }

    public getActiveTicket(): DispatchTicket | null {
        return this.activeTicket;
    }

    public getBanner(): BannerState {
        return this.currentBanner;
    }

    public isBusy(): boolean {
        return this.isInspecting;
    }

    public clearBanner(): void {
        this.currentBanner = { type: 'None' };
    }

    /**
     * Entrypoint for developer prompt submission.
     * Evaluates AI Access first, followed by DLP inspection if cleared.
     */
    public async startSubmission(
        promptText: string,
        selectedCode?: string,
        serviceId: string = 'github_copilot'
    ): Promise<DispatchTicket> {
        const trimmedPrompt = promptText.trim();
        if (!trimmedPrompt) {
            throw new Error('Prompt cannot be empty');
        }

        const fullSnapshot = promptText + (selectedCode ? '\n' + selectedCode : '');
        const contentHash = hashContent(fullSnapshot);

        const ticketId = `sub_${Date.now()}_${++this.ticketCounter}`;
        const ticket: DispatchTicket = {
            id: ticketId,
            contentHash,
            targetService: serviceId,
            state: 'PENDING',
            rawContent: fullSnapshot,
            createdAt: Date.now(),
        };

        this.activeTicket = ticket;
        this.isInspecting = true;

        try {
            if (!this.client.isConnected()) {
                this.failClosed(ticket, 'Agent disconnected. Submission blocked.');
                return ticket;
            }

            // Step 1: Evaluate AI Access first (authoritative policy check)
            const accessResp = await this.client.evaluateAiAccess(serviceId, 'Policy');

            if (accessResp.decision === 'Block') {
                ticket.state = 'INVALIDATED';
                ticket.action = 'Block';
                this.currentBanner = {
                    type: 'Block',
                    title: 'AI Service Blocked',
                    message: `ShadowShield blocked access to ${serviceId} based on organization policy.`,
                };
                return ticket;
            }

            if (accessResp.decision === 'Coach') {
                ticket.state = 'PENDING';
                ticket.action = 'Coach';
                ticket.coachReason = 'AiAccess';
                this.currentBanner = {
                    type: 'Coach',
                    coachReason: 'AiAccess',
                    title: 'AI Service Review',
                    message: `This AI service (${serviceId}) requires review under your organization's policy.`,
                };
                return ticket;
            }

            // Step 2: If AI Access cleared (Allow / AllowRestricted), proceed to DLP Inspect
            return await this.runDlpInspection(ticket);
        } catch (err: any) {
            const msg = err?.message || 'Inspection error';
            this.failClosed(ticket, `ShadowShield request failed: ${msg}`);
            return ticket;
        } finally {
            this.isInspecting = false;
        }
    }

    /**
     * Executes DLP inspection against the Rust core.
     * Only called after AI Access is confirmed.
     */
    private async runDlpInspection(ticket: DispatchTicket): Promise<DispatchTicket> {
        try {
            const inspectResp = await this.client.inspect({
                source: 'VSCode',
                ai_service: ticket.targetService,
                content: ticket.rawContent,
                timestamp: Date.now(),
            });

            ticket.action = inspectResp.action;

            switch (inspectResp.action) {
                case 'Allow':
                    ticket.state = 'AUTHORIZED';
                    ticket.authorizedContent = ticket.rawContent;
                    this.currentBanner = {
                        type: 'Allow',
                        title: 'Submission Allowed',
                        message: 'ShadowShield verified prompt content against security policy.',
                    };
                    break;

                case 'Coach':
                    ticket.state = 'PENDING';
                    ticket.coachReason = 'DataProtection';
                    this.currentBanner = {
                        type: 'Coach',
                        coachReason: 'DataProtection',
                        title: 'Sensitive Information Detected',
                        message:
                            'ShadowShield detected potentially sensitive information in this request. Review before continuing.',
                    };
                    break;

                case 'Redact':
                    if (inspectResp.sanitized_content !== null && inspectResp.sanitized_content !== undefined) {
                        ticket.state = 'PENDING';
                        ticket.authorizedContent = inspectResp.sanitized_content;
                        this.currentBanner = {
                            type: 'Redact',
                            title: 'Data Redacted',
                            message:
                                'Sensitive information was removed from this request before dispatch.',
                            sanitizedContent: inspectResp.sanitized_content,
                        };
                    } else {
                        // Fail closed if sanitized_content is unexpectedly missing
                        this.failClosed(ticket, 'Redaction engine returned empty content.');
                    }
                    break;

                case 'Block':
                default:
                    ticket.state = 'INVALIDATED';
                    this.currentBanner = {
                        type: 'Block',
                        title: 'Submission Blocked',
                        message:
                            'ShadowShield blocked this request based on your organization\'s policy.',
                    };
                    break;
            }

            return ticket;
        } catch (err: any) {
            const msg = err?.message || 'DLP inspection failure';
            this.failClosed(ticket, `DLP inspection failed: ${msg}`);
            return ticket;
        }
    }

    /**
     * Handles user clicking Proceed on a Coach banner.
     * Enforces stale-content protection by checking hash before resuming.
     */
    public async handleCoachProceed(
        ticketId: string,
        currentPromptText: string,
        currentSelectedCode?: string
    ): Promise<DispatchTicket> {
        const ticket = this.validatePendingTicket(ticketId);

        // Stale-content check: Verify user did not edit content while coach banner was displayed
        const currentSnapshot = currentPromptText + (currentSelectedCode ? '\n' + currentSelectedCode : '');
        const currentHash = hashContent(currentSnapshot);

        if (currentHash !== ticket.contentHash) {
            // Content mutated during wait — safely discard decision
            ticket.state = 'INVALIDATED';
            this.currentBanner = {
                type: 'Block',
                title: 'Submission Cancelled (Stale Content)',
                message:
                    'Composer content was modified while awaiting confirmation. Inspection discarded.',
            };
            return ticket;
        }

        // If this was an AI Access coach, proceeding now advances to DLP inspection
        if (ticket.coachReason === 'AiAccess') {
            this.isInspecting = true;
            try {
                return await this.runDlpInspection(ticket);
            } finally {
                this.isInspecting = false;
            }
        }

        // If this was DLP coach, proceeding authorizes the original snapshot
        if (ticket.coachReason === 'DataProtection') {
            ticket.state = 'AUTHORIZED';
            ticket.authorizedContent = ticket.rawContent;
            this.currentBanner = {
                type: 'Allow',
                title: 'Submission Authorized',
                message: 'Developer acknowledged coach advisory. Ready for dispatch.',
            };
            return ticket;
        }

        ticket.state = 'INVALIDATED';
        return ticket;
    }

    /**
     * Handles user clicking Cancel on a Coach banner.
     */
    public handleCoachCancel(ticketId: string): DispatchTicket {
        const ticket = this.validatePendingTicket(ticketId);
        ticket.state = 'INVALIDATED';
        this.currentBanner = { type: 'None' };
        return ticket;
    }

    /**
     * Handles user confirming redaction write-back and dispatch.
     */
    public handleRedactProceed(ticketId: string): DispatchTicket {
        const ticket = this.validatePendingTicket(ticketId);
        if (!ticket.authorizedContent) {
            this.failClosed(ticket, 'No sanitized content available for dispatch');
            return ticket;
        }

        ticket.state = 'AUTHORIZED';
        this.currentBanner = {
            type: 'Allow',
            title: 'Redacted Prompt Authorized',
            message: 'Sanitized text ready for dispatch.',
        };
        return ticket;
    }

    public handleRedactCancel(ticketId: string): DispatchTicket {
        const ticket = this.validatePendingTicket(ticketId);
        ticket.state = 'INVALIDATED';
        this.currentBanner = { type: 'None' };
        return ticket;
    }

    private validatePendingTicket(ticketId: string): DispatchTicket {
        if (!this.activeTicket || this.activeTicket.id !== ticketId) {
            throw new Error(`Ticket ${ticketId} not found or inactive`);
        }
        if (this.activeTicket.state !== 'PENDING') {
            throw new Error(`Ticket ${ticketId} is not in PENDING state (is: ${this.activeTicket.state})`);
        }
        return this.activeTicket;
    }

    private failClosed(ticket: DispatchTicket, reason: string): void {
        ticket.state = 'INVALIDATED';
        this.currentBanner = {
            type: 'Disconnected',
            title: 'Protection Unavailable (Fail Closed)',
            message: reason,
        };
    }
}
