import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VsCodeEnforcementController } from '../../src/controller/enforcement-controller';
import { MockIpcClient } from '../../src/ipc/mock-client';
import {
    NEUTRAL_PROMPT_1,
    NEUTRAL_CODE_SNIPPET,
    NEUTRAL_MUTATED_CODE,
    NEUTRAL_SANITIZED_SNIPPET,
} from '../fixtures/neutral-fixtures';

describe('VsCodeEnforcementController — Enforcement Lifecycle', () => {
    let client: MockIpcClient;
    let controller: VsCodeEnforcementController;

    beforeEach(() => {
        client = new MockIpcClient();
        controller = new VsCodeEnforcementController(client);
    });

    // -------------------------------------------------------------------------
    // 1. Validation
    // -------------------------------------------------------------------------
    it('rejects empty or whitespace-only prompt submission', async () => {
        await expect(controller.startSubmission('')).rejects.toThrow('Prompt cannot be empty');
        await expect(controller.startSubmission('   \n  ')).rejects.toThrow('Prompt cannot be empty');
    });

    // -------------------------------------------------------------------------
    // 2. Mock ALLOW
    // -------------------------------------------------------------------------
    it('ALLOW: authorizes prompt and marks ticket as AUTHORIZED with exact snapshot', async () => {
        client.setAllow();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);

        expect(ticket.state).toBe('AUTHORIZED');
        expect(ticket.action).toBe('Allow');
        expect(ticket.authorizedContent).toBe(NEUTRAL_PROMPT_1 + '\n' + NEUTRAL_CODE_SNIPPET);

        const banner = controller.getBanner();
        expect(banner.type).toBe('Allow');
        expect(banner.title).toBe('Submission Allowed');
    });

    // -------------------------------------------------------------------------
    // 3. Mock AI Access BLOCK
    // -------------------------------------------------------------------------
    it('AI Access BLOCK: invalidates ticket immediately without calling DLP inspection', async () => {
        client.setAiAccessBlock();
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(ticket.state).toBe('INVALIDATED');
        expect(ticket.action).toBe('Block');
        expect(ticket.authorizedContent).toBeUndefined();
        expect(inspectSpy).not.toHaveBeenCalled();

        const banner = controller.getBanner();
        expect(banner.type).toBe('Block');
        expect(banner.title).toBe('AI Service Blocked');
    });

    // -------------------------------------------------------------------------
    // 4. Mock AI Access COACH (Cancel vs Proceed)
    // -------------------------------------------------------------------------
    it('AI Access COACH: displays AI Service Review banner without DLP wording', async () => {
        client.setAiAccessCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);

        expect(ticket.state).toBe('PENDING');
        expect(ticket.action).toBe('Coach');
        expect(ticket.coachReason).toBe('AiAccess');

        const banner = controller.getBanner();
        expect(banner.type).toBe('Coach');
        if (banner.type === 'Coach') {
            expect(banner.coachReason).toBe('AiAccess');
            expect(banner.title).toBe('AI Service Review');
            // Invariant: AI Access Coach must NOT claim sensitive data detected
            expect(banner.message).not.toContain('sensitive');
        }
    });

    it('AI Access COACH Cancel: halts submission and invalidates ticket', async () => {
        client.setAiAccessCoach();
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        const cancelledTicket = controller.handleCoachCancel(ticket.id);

        expect(cancelledTicket.state).toBe('INVALIDATED');
        expect(inspectSpy).not.toHaveBeenCalled();
        expect(controller.getBanner().type).toBe('None');
    });

    it('AI Access COACH Proceed: advances to DLP inspection and authorizes if safe', async () => {
        client.setAiAccessCoach();
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);
        expect(ticket.state).toBe('PENDING');

        // User clicks Proceed with unchanged content
        const proceededTicket = await controller.handleCoachProceed(
            ticket.id,
            NEUTRAL_PROMPT_1,
            NEUTRAL_CODE_SNIPPET
        );

        expect(inspectSpy).toHaveBeenCalledTimes(1);
        expect(proceededTicket.state).toBe('AUTHORIZED');
        expect(proceededTicket.authorizedContent).toBe(NEUTRAL_PROMPT_1 + '\n' + NEUTRAL_CODE_SNIPPET);
    });

    // -------------------------------------------------------------------------
    // 5. Mock DLP COACH (Cancel vs Proceed)
    // -------------------------------------------------------------------------
    it('DLP COACH: displays Sensitive Information Detected banner', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(ticket.state).toBe('PENDING');
        expect(ticket.coachReason).toBe('DataProtection');

        const banner = controller.getBanner();
        expect(banner.type).toBe('Coach');
        if (banner.type === 'Coach') {
            expect(banner.coachReason).toBe('DataProtection');
            expect(banner.title).toBe('Sensitive Information Detected');
            expect(banner.message).toContain('sensitive');
        }
    });

    it('DLP COACH Cancel: invalidates ticket', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        const cancelledTicket = controller.handleCoachCancel(ticket.id);

        expect(cancelledTicket.state).toBe('INVALIDATED');
        expect(cancelledTicket.authorizedContent).toBeUndefined();
    });

    it('DLP COACH Proceed: authorizes prompt snapshot when user explicitly proceeds', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        const proceededTicket = await controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1);

        expect(proceededTicket.state).toBe('AUTHORIZED');
        expect(proceededTicket.authorizedContent).toBe(NEUTRAL_PROMPT_1);
    });

    // -------------------------------------------------------------------------
    // 6. Stale-Content Protection
    // -------------------------------------------------------------------------
    it('Stale Content: invalidates ticket and discards decision if content modified while awaiting Coach', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);
        expect(ticket.state).toBe('PENDING');

        // User mutates code in editor while coach banner is open
        const staleTicket = await controller.handleCoachProceed(
            ticket.id,
            NEUTRAL_PROMPT_1,
            NEUTRAL_MUTATED_CODE
        );

        expect(staleTicket.state).toBe('INVALIDATED');
        expect(staleTicket.authorizedContent).toBeUndefined();

        const banner = controller.getBanner();
        expect(banner.type).toBe('Block');
        expect(banner.title).toContain('Stale Content');
    });

    // -------------------------------------------------------------------------
    // 7. Mock REDACT (write-back and proceed)
    // -------------------------------------------------------------------------
    it('DLP REDACT: stages sanitized content in PENDING ticket with Redact banner', async () => {
        client.setDlpRedact(NEUTRAL_SANITIZED_SNIPPET);

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(ticket.state).toBe('PENDING');
        expect(ticket.action).toBe('Redact');
        expect(ticket.authorizedContent).toBe(NEUTRAL_SANITIZED_SNIPPET);

        const banner = controller.getBanner();
        expect(banner.type).toBe('Redact');
        if (banner.type === 'Redact') {
            expect(banner.sanitizedContent).toBe(NEUTRAL_SANITIZED_SNIPPET);
        }
    });

    it('DLP REDACT Proceed: authorizes sanitized text for dispatch', async () => {
        client.setDlpRedact(NEUTRAL_SANITIZED_SNIPPET);

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        const authorizedTicket = controller.handleRedactProceed(ticket.id);

        expect(authorizedTicket.state).toBe('AUTHORIZED');
        expect(authorizedTicket.authorizedContent).toBe(NEUTRAL_SANITIZED_SNIPPET);
    });

    it('DLP REDACT Cancel: invalidates ticket', async () => {
        client.setDlpRedact(NEUTRAL_SANITIZED_SNIPPET);

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        const cancelledTicket = controller.handleRedactCancel(ticket.id);

        expect(cancelledTicket.state).toBe('INVALIDATED');
    });

    // -------------------------------------------------------------------------
    // 8. Mock BLOCK
    // -------------------------------------------------------------------------
    it('DLP BLOCK: halts submission, invalidates ticket, displays Block banner', async () => {
        client.setDlpBlock();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(ticket.state).toBe('INVALIDATED');
        expect(ticket.action).toBe('Block');
        expect(ticket.authorizedContent).toBeUndefined();

        const banner = controller.getBanner();
        expect(banner.type).toBe('Block');
        expect(banner.title).toBe('Submission Blocked');
    });

    // -------------------------------------------------------------------------
    // 9. Fail-Closed Error Handling
    // -------------------------------------------------------------------------
    it('Transport Failure / Disconnected: fails closed and blocks submission', async () => {
        client.disconnect();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(ticket.state).toBe('INVALIDATED');
        expect(ticket.authorizedContent).toBeUndefined();

        const banner = controller.getBanner();
        expect(banner.type).toBe('Disconnected');
        expect(banner.title).toContain('Fail Closed');
    });
});
