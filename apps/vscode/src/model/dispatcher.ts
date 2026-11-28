import * as vscode from 'vscode';
import { DispatchTicket } from '../controller/types';

export interface DispatchResult {
    success: boolean;
    destinationService: string;
    transmittedContent: string;
    output?: string;
    error?: string;
}

export interface ModelDispatchOptions {
    vscodeRef?: any;
    cancellationToken?: any;
}

/**
 * ControlledDispatcher ensures no prompt content is ever dispatched
 * to an external model or API unless backed by an AUTHORIZED ticket.
 *
 * Implements atomic state transition: AUTHORIZED -> DISPATCHING -> CONSUMED
 * Guarantees application-level single-use dispatch and fail-closed security.
 */
export class ControlledDispatcher {
    /**
     * Dispatches authorized prompt content to a verified LanguageModelChat from vscode.lm.
     *
     * Invariants:
     * 1. Ticket MUST be in AUTHORIZED state.
     * 2. Ticket MUST contain authorizedContent.
     * 3. Target model MUST be verified (vendor === 'copilot').
     * 4. Model ID MUST match ticket.modelId (prevents model mutation).
     * 5. Transitions atomically to DISPATCHING before calling sendRequest().
     * 6. Only authorizedContent is transmitted. Original raw content is NEVER transmitted after REDACT.
     * 7. Transitions to CONSUMED upon completion or error.
     * 8. Never retries ambiguous failures (prevents duplicate provider submissions).
     */
    public static async dispatchToModel(
        ticket: DispatchTicket,
        targetModel: any,
        options?: ModelDispatchOptions
    ): Promise<DispatchResult> {
        // Enforce the critical security invariant:
        // No direct AI/model submission path before ShadowShield authorization.
        if (ticket.state !== 'AUTHORIZED') {
            throw new Error(
                `Security violation: Attempted AI dispatch for ticket ${ticket.id} in unauthorized state "${ticket.state}"`
            );
        }

        if (!ticket.authorizedContent || ticket.authorizedContent.trim().length === 0) {
            ticket.state = 'INVALIDATED';
            throw new Error(
                `Security violation: Ticket ${ticket.id} is AUTHORIZED but contains no authorizedContent`
            );
        }

        // Enforce model identity invariants
        if (!targetModel) {
            ticket.state = 'INVALIDATED';
            throw new Error('Security violation: No target model provided for dispatch');
        }

        if (targetModel.vendor !== 'copilot') {
            ticket.state = 'INVALIDATED';
            throw new Error(
                `Security violation: Target model vendor "${targetModel.vendor}" is not approved (expected "copilot")`
            );
        }

        if (ticket.modelId && targetModel.id !== ticket.modelId) {
            ticket.state = 'INVALIDATED';
            throw new Error(
                `Security violation: Target model ID "${targetModel.id}" does not match authorized model ID "${ticket.modelId}"`
            );
        }

        // Atomic transition to DISPATCHING (prevents concurrent or duplicate send)
        ticket.state = 'DISPATCHING';

        const contentToSend = ticket.authorizedContent;

        try {
            const vscodeRef =
                options?.vscodeRef || (typeof vscode !== 'undefined' ? vscode : null);

            if (options?.cancellationToken?.isCancellationRequested) {
                ticket.state = 'CONSUMED';
                return {
                    success: false,
                    destinationService: ticket.targetService,
                    transmittedContent: contentToSend,
                    error: 'Operation was cancelled before dispatch',
                };
            }

            let userMessage: any;
            if (vscodeRef?.LanguageModelChatMessage?.User) {
                userMessage = vscodeRef.LanguageModelChatMessage.User(contentToSend);
            } else {
                userMessage = { role: 1, content: contentToSend };
            }

            const response = await targetModel.sendRequest(
                [userMessage],
                {},
                options?.cancellationToken
            );

            let outputText = '';
            if (response?.text) {
                if (typeof response.text[Symbol.asyncIterator] === 'function') {
                    for await (const chunk of response.text) {
                        if (options?.cancellationToken?.isCancellationRequested) {
                            throw new Error('Operation was cancelled during streaming');
                        }
                        outputText += chunk;
                    }
                } else if (typeof response.text === 'string') {
                    outputText = response.text;
                }
            }

            // Successfully dispatched and consumed (single-use lifecycle)
            ticket.state = 'CONSUMED';

            return {
                success: true,
                destinationService: ticket.targetService,
                transmittedContent: contentToSend,
                output: outputText,
            };
        } catch (err: any) {
            // Immediately transition to CONSUMED so ticket cannot be retried or replayed
            ticket.state = 'CONSUMED';

            return {
                success: false,
                destinationService: ticket.targetService,
                transmittedContent: contentToSend,
                error: err?.message || 'Language model request failed',
            };
        }
    }

    /**
     * Generic/mock dispatch for deterministic unit tests.
     */
    public static async dispatch(
        ticket: DispatchTicket,
        destinationSender?: (content: string) => Promise<string>
    ): Promise<DispatchResult> {
        if (ticket.state !== 'AUTHORIZED') {
            throw new Error(
                `Security violation: Attempted AI dispatch for ticket ${ticket.id} in unauthorized state "${ticket.state}"`
            );
        }

        if (!ticket.authorizedContent) {
            ticket.state = 'INVALIDATED';
            throw new Error(
                `Security violation: Ticket ${ticket.id} is AUTHORIZED but contains no authorizedContent`
            );
        }

        // Atomic transition to DISPATCHING
        ticket.state = 'DISPATCHING';

        const contentToSend = ticket.authorizedContent;

        try {
            let output: string | undefined;
            if (destinationSender) {
                output = await destinationSender(contentToSend);
            }

            ticket.state = 'CONSUMED';

            return {
                success: true,
                destinationService: ticket.targetService,
                transmittedContent: contentToSend,
                output,
            };
        } catch (err: any) {
            ticket.state = 'CONSUMED';
            return {
                success: false,
                destinationService: ticket.targetService,
                transmittedContent: contentToSend,
                error: err?.message || 'Dispatch failed',
            };
        }
    }
}
