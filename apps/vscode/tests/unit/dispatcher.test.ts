import { describe, it, expect, vi } from 'vitest';
import { ControlledDispatcher } from '../../src/model/dispatcher';
import { DispatchTicket } from '../../src/controller/types';
import { NEUTRAL_PROMPT_1 } from '../fixtures/neutral-fixtures';

describe('ControlledDispatcher — AI/Model Submission Barrier', () => {
    it('rejects dispatch if ticket is PENDING (no direct send before authorization)', async () => {
        const ticket: DispatchTicket = {
            id: 'sub-001',
            contentHash: 'hash',
            targetService: 'github_copilot',
            state: 'PENDING',
            rawContent: NEUTRAL_PROMPT_1,
            createdAt: Date.now(),
        };

        const mockSender = vi.fn();

        await expect(ControlledDispatcher.dispatch(ticket, mockSender)).rejects.toThrow(
            'Security violation: Attempted AI dispatch for ticket sub-001 in unauthorized state "PENDING"'
        );

        expect(mockSender).not.toHaveBeenCalled();
    });

    it('rejects dispatch if ticket is INVALIDATED (e.g. Blocked or Cancelled)', async () => {
        const ticket: DispatchTicket = {
            id: 'sub-002',
            contentHash: 'hash',
            targetService: 'github_copilot',
            state: 'INVALIDATED',
            rawContent: NEUTRAL_PROMPT_1,
            createdAt: Date.now(),
        };

        const mockSender = vi.fn();

        await expect(ControlledDispatcher.dispatch(ticket, mockSender)).rejects.toThrow(
            'Security violation: Attempted AI dispatch for ticket sub-002 in unauthorized state "INVALIDATED"'
        );

        expect(mockSender).not.toHaveBeenCalled();
    });

    it('dispatches only when ticket is AUTHORIZED, transitioning to DISPATCHING then CONSUMED', async () => {
        const ticket: DispatchTicket = {
            id: 'sub-003',
            contentHash: 'hash',
            targetService: 'github_copilot',
            state: 'AUTHORIZED',
            rawContent: NEUTRAL_PROMPT_1,
            authorizedContent: NEUTRAL_PROMPT_1,
            createdAt: Date.now(),
        };

        let observedStateDuringSend: string | undefined;
        const mockSender = vi.fn(async (content: string) => {
            observedStateDuringSend = ticket.state;
            return `Model answer for: ${content}`;
        });

        const result = await ControlledDispatcher.dispatch(ticket, mockSender);

        // Invariant: exactly-once dispatch
        expect(mockSender).toHaveBeenCalledTimes(1);
        expect(mockSender).toHaveBeenCalledWith(NEUTRAL_PROMPT_1);

        // State was DISPATCHING during send
        expect(observedStateDuringSend).toBe('DISPATCHING');

        // State is CONSUMED after send
        expect(ticket.state).toBe('CONSUMED');
        expect(result.success).toBe(true);
        expect(result.output).toBe(`Model answer for: ${NEUTRAL_PROMPT_1}`);
    });

    it('rejects second dispatch attempt on an already CONSUMED ticket (exactly-once)', async () => {
        const ticket: DispatchTicket = {
            id: 'sub-004',
            contentHash: 'hash',
            targetService: 'github_copilot',
            state: 'CONSUMED',
            rawContent: NEUTRAL_PROMPT_1,
            authorizedContent: NEUTRAL_PROMPT_1,
            createdAt: Date.now(),
        };

        const mockSender = vi.fn();

        await expect(ControlledDispatcher.dispatch(ticket, mockSender)).rejects.toThrow(
            'Security violation: Attempted AI dispatch for ticket sub-004 in unauthorized state "CONSUMED"'
        );

        expect(mockSender).not.toHaveBeenCalled();
    });
});
