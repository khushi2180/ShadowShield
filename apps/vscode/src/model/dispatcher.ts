import { DispatchTicket } from '../controller/types';

export interface DispatchResult {
    success: boolean;
    destinationService: string;
    transmittedContent: string;
    output?: string;
    error?: string;
}

/**
 * ControlledDispatcher ensures no prompt content is ever dispatched
 * to an external model or API unless backed by an AUTHORIZED ticket.
 *
 * Implements atomic state transition: AUTHORIZED -> DISPATCHING -> CONSUMED
 */
export class ControlledDispatcher {
    public static async dispatch(
        ticket: DispatchTicket,
        destinationSender?: (content: string) => Promise<string>
    ): Promise<DispatchResult> {
        // Enforce the critical security invariant:
        // No direct AI/model submission path before ShadowShield authorization.
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

        // Atomic transition to DISPATCHING (prevents concurrent or duplicate send)
        ticket.state = 'DISPATCHING';

        const contentToSend = ticket.authorizedContent;

        try {
            let output: string | undefined;
            if (destinationSender) {
                output = await destinationSender(contentToSend);
            }

            // Successfully dispatched and consumed
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
