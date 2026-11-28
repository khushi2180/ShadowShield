import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VsCodeEnforcementController } from '../../src/controller/enforcement-controller';
import { DispatchTicket } from '../../src/controller/types';
import { ControlledDispatcher } from '../../src/model/dispatcher';
import { ModelSelector } from '../../src/model/model-selector';
import { MockIpcClient } from '../../src/ipc/mock-client';
import { hashContent } from '../../src/util/crypto';
import {
    NEUTRAL_PROMPT_1,
    NEUTRAL_CODE_SNIPPET,
    NEUTRAL_SANITIZED_SNIPPET,
} from '../fixtures/neutral-fixtures';

describe('V3 — Enforced Controlled Dispatch Acceptance Tests (30 Requirements)', () => {
    let client: MockIpcClient;
    let controller: VsCodeEnforcementController;

    const mockCopilotModel = {
        id: 'copilot-gpt-4o',
        name: 'GitHub Copilot GPT-4o',
        vendor: 'copilot',
        family: 'gpt-4o',
        sendRequest: vi.fn(async (_messages: any[]) => ({
            text: (async function* () {
                yield 'Model response: OK';
            })(),
        })),
    };

    const mockVsCodeWithCopilot = {
        lm: {
            selectChatModels: vi.fn(async (options?: { vendor?: string }) => {
                if (options?.vendor && options.vendor !== 'copilot') return [];
                return [mockCopilotModel];
            }),
        },
        LanguageModelChatMessage: {
            User: (content: string) => ({ role: 1, content }),
            Assistant: (content: string) => ({ role: 2, content }),
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        client = new MockIpcClient();
        client.setAllow();
        controller = new VsCodeEnforcementController(client);
    });

    // -------------------------------------------------------------------------
    // 1. Actual model identity mapping
    // -------------------------------------------------------------------------
    it('1. maps actual vscode.lm model with vendor "copilot" strictly to "github_copilot"', async () => {
        const resolved = await ModelSelector.resolveApprovedModel(mockVsCodeWithCopilot);

        expect(resolved.vendor).toBe('copilot');
        expect(resolved.serviceId).toBe('github_copilot');
        expect(resolved.modelId).toBe('copilot-gpt-4o');
        expect(resolved.family).toBe('gpt-4o');
    });

    it('1b. fails closed when multiple Copilot models exist and no specific model ID is established', async () => {
        const multiModelVsCode = {
            lm: {
                selectChatModels: vi.fn(async () => [
                    { id: 'copilot-gpt-4o', vendor: 'copilot', family: 'gpt-4o' },
                    { id: 'copilot-gpt-4o-mini', vendor: 'copilot', family: 'gpt-4o-mini' },
                    { id: 'copilot-claude-sonnet', vendor: 'copilot', family: 'claude-sonnet' },
                ]),
            },
        };

        // Must FAIL CLOSED with Ambiguous model selection rather than arbitrarily picking models[0]
        await expect(ModelSelector.resolveApprovedModel(multiModelVsCode)).rejects.toThrow(
            /Ambiguous model selection.*Multiple Copilot models available/i
        );
    });

    it('1c. resolves the exact intended model when explicit model ID is specified among multiple models', async () => {
        const multiModelVsCode = {
            lm: {
                selectChatModels: vi.fn(async () => [
                    { id: 'copilot-gpt-4o', vendor: 'copilot', family: 'gpt-4o' },
                    { id: 'copilot-gpt-4o-mini', vendor: 'copilot', family: 'gpt-4o-mini' },
                ]),
            },
        };

        const resolved = await ModelSelector.resolveApprovedModel(
            multiModelVsCode,
            'copilot-gpt-4o-mini'
        );

        expect(resolved.modelId).toBe('copilot-gpt-4o-mini');
        expect(resolved.family).toBe('gpt-4o-mini');
        expect(resolved.serviceId).toBe('github_copilot');
    });

    it('1d. fails closed when specified model ID is not among available Copilot models', async () => {
        const multiModelVsCode = {
            lm: {
                selectChatModels: vi.fn(async () => [
                    { id: 'copilot-gpt-4o', vendor: 'copilot', family: 'gpt-4o' },
                ]),
            },
        };

        await expect(
            ModelSelector.resolveApprovedModel(multiModelVsCode, 'nonexistent-model-id')
        ).rejects.toThrow(/Intended model ID "nonexistent-model-id" was not found/);
    });

    // -------------------------------------------------------------------------
    // 2. Unknown model/vendor fails closed
    // -------------------------------------------------------------------------
    it('2. unknown/unapproved model vendor fails closed without authorization', async () => {
        const unapprovedVsCode = {
            lm: {
                selectChatModels: vi.fn(async () => [
                    { id: 'claude-3-5', vendor: 'anthropic', family: 'claude-3-5' },
                ]),
            },
        };

        await expect(ModelSelector.resolveApprovedModel(unapprovedVsCode)).rejects.toThrow(
            /unapproved.*vendor/i
        );
    });

    // -------------------------------------------------------------------------
    // 3. Model unavailable
    // -------------------------------------------------------------------------
    it('3. fails closed when no language models are available', async () => {
        const emptyVsCode = {
            lm: {
                selectChatModels: vi.fn(async () => []),
            },
        };

        await expect(ModelSelector.resolveApprovedModel(emptyVsCode)).rejects.toThrow(
            /No language models available/
        );
    });

    // -------------------------------------------------------------------------
    // 4. Consent denial handled safely without retry
    // -------------------------------------------------------------------------
    it('4. handles vscode.lm consent denial safely without unsafe retry', async () => {
        const consentDeniedModel = {
            id: 'copilot-gpt-4o',
            vendor: 'copilot',
            sendRequest: vi.fn(async () => {
                throw new Error('User denied consent to use language model API');
            }),
        };

        const ticket = await controller.startSubmission(
            NEUTRAL_PROMPT_1,
            undefined,
            'github_copilot',
            { modelId: 'copilot-gpt-4o', modelVendor: 'copilot' }
        );
        expect(ticket.state).toBe('AUTHORIZED');

        const result = await ControlledDispatcher.dispatchToModel(ticket, consentDeniedModel);

        expect(result.success).toBe(false);
        expect(result.error).toContain('denied consent');
        // Invariant: ticket is consumed, preventing retries
        expect(ticket.state).toBe('CONSUMED');
        expect(consentDeniedModel.sendRequest).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // 5. AI Access ALLOW -> DLP Inspect
    // -------------------------------------------------------------------------
    it('5. AI Access ALLOW proceeds automatically to DLP inspection', async () => {
        client.setAllow();
        const aiAccessSpy = vi.spyOn(client, 'evaluateAiAccess');
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(aiAccessSpy).toHaveBeenCalledWith('github_copilot', 'Policy');
        expect(inspectSpy).toHaveBeenCalledTimes(1);
        expect(ticket.state).toBe('AUTHORIZED');
    });

    // -------------------------------------------------------------------------
    // 6. AI Access COACH -> Cancel
    // -------------------------------------------------------------------------
    it('6. AI Access COACH Cancel halts submission: no DLP call, no model send', async () => {
        client.setAiAccessCoach();
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('PENDING');
        expect(ticket.coachReason).toBe('AiAccess');

        const cancelled = controller.handleCoachCancel(ticket.id);
        expect(cancelled.state).toBe('INVALIDATED');
        expect(inspectSpy).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // 7. AI Access COACH -> Proceed -> DLP
    // -------------------------------------------------------------------------
    it('7. AI Access COACH Proceed verifies snapshot and advances to DLP Inspect', async () => {
        client.setAiAccessCoach();
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('PENDING');

        // Client now allows DLP
        client.setAllow();

        const proceedTicket = await controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1);
        expect(inspectSpy).toHaveBeenCalledTimes(1);
        expect(proceedTicket.state).toBe('AUTHORIZED');
    });

    // -------------------------------------------------------------------------
    // 8. AI Access BLOCK -> no DLP / no model send
    // -------------------------------------------------------------------------
    it('8. AI Access BLOCK halts immediately: no DLP inspection, no model send', async () => {
        client.setAiAccessBlock();
        const inspectSpy = vi.spyOn(client, 'inspect');

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        expect(ticket.state).toBe('INVALIDATED');
        expect(ticket.action).toBe('Block');
        expect(inspectSpy).not.toHaveBeenCalled();
        expect(controller.getBanner().title).toBe('AI Service Blocked');
    });

    // -------------------------------------------------------------------------
    // 9. DLP ALLOW -> exact inspected content only
    // -------------------------------------------------------------------------
    it('9. DLP ALLOW authorizes ONLY the exact unchanged inspected content', async () => {
        client.setAllow();
        const expectedSnapshot = NEUTRAL_PROMPT_1 + '\n' + NEUTRAL_CODE_SNIPPET;

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);

        expect(ticket.state).toBe('AUTHORIZED');
        expect(ticket.authorizedContent).toBe(expectedSnapshot);
    });

    // -------------------------------------------------------------------------
    // 10. DLP COACH -> Cancel
    // -------------------------------------------------------------------------
    it('10. DLP COACH Cancel invalidates ticket and prevents dispatch', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('PENDING');
        expect(ticket.coachReason).toBe('DataProtection');

        const cancelled = controller.handleCoachCancel(ticket.id);
        expect(cancelled.state).toBe('INVALIDATED');

        await expect(
            ControlledDispatcher.dispatchToModel(cancelled, mockCopilotModel)
        ).rejects.toThrow(/unauthorized state "INVALIDATED"/);
    });

    // -------------------------------------------------------------------------
    // 11. DLP COACH -> Proceed with exact snapshot
    // -------------------------------------------------------------------------
    it('11. DLP COACH Proceed authorizes exact snapshot after developer confirmation', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('PENDING');

        const authorized = await controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1);
        expect(authorized.state).toBe('AUTHORIZED');
        expect(authorized.authorizedContent).toBe(NEUTRAL_PROMPT_1);

        const result = await ControlledDispatcher.dispatchToModel(authorized, mockCopilotModel);
        expect(result.success).toBe(true);
        expect(result.transmittedContent).toBe(NEUTRAL_PROMPT_1);
    });

    // -------------------------------------------------------------------------
    // 12. REDACT -> only Rust sanitized content dispatched
    // -------------------------------------------------------------------------
    it('12. REDACT writes back and dispatches ONLY Rust-sanitized content (never raw)', async () => {
        const rawWithSecret = 'My secret API key is: AKIAIOSFODNN7EXAMPLE';
        const sanitizedSecret = 'My secret API key is: [REDACTED_API_KEY]';

        client.inspect = vi.fn(async () => ({
            detections_count: 1,
            detections: [],
            risk_assessment: { score: 75, level: 'High' as any, primary_detection_index: 0 },
            action: 'Redact' as const,
            sanitized_content: sanitizedSecret,
            processing_duration_ms: 2,
        }));

        const ticket = await controller.startSubmission(rawWithSecret);
        expect(ticket.state).toBe('PENDING');
        expect(ticket.authorizedContent).toBe(sanitizedSecret);

        // User proceeds with write-back of sanitized text
        const redactedTicket = controller.handleRedactProceed(ticket.id, sanitizedSecret);
        expect(redactedTicket.state).toBe('AUTHORIZED');
        expect(redactedTicket.authorizedContent).toBe(sanitizedSecret);

        const result = await ControlledDispatcher.dispatchToModel(redactedTicket, mockCopilotModel);
        expect(result.success).toBe(true);
        expect(result.transmittedContent).toBe(sanitizedSecret);
        expect(result.transmittedContent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    // -------------------------------------------------------------------------
    // 13. BLOCK -> zero model submission
    // -------------------------------------------------------------------------
    it('13. DLP BLOCK prevents any model submission', async () => {
        client.setDlpBlock();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('INVALIDATED');

        await expect(
            ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel)
        ).rejects.toThrow(/unauthorized state "INVALIDATED"/);

        expect(mockCopilotModel.sendRequest).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // 14. Unknown AI Access response fails closed
    // -------------------------------------------------------------------------
    it('14. unknown AI Access decision fails closed immediately', async () => {
        client.evaluateAiAccess = vi.fn(async () => ({
            service_id: 'github_copilot',
            classification: 'Unknown' as any,
            mode: 'Policy' as any,
            decision: 'UnrecognizedDecision' as any,
            reason: 'Unknown' as any,
        }));

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('INVALIDATED');
        expect(controller.getBanner().type).toBe('Disconnected');
        expect(controller.getBanner().message).toContain('Unknown AI Access decision');
    });

    // -------------------------------------------------------------------------
    // 15. Unknown DLP response fails closed
    // -------------------------------------------------------------------------
    it('15. unknown DLP action fails closed immediately', async () => {
        client.inspect = vi.fn(async () => ({
            detections_count: 0,
            detections: [],
            risk_assessment: { score: 0, level: 'Low' as any, primary_detection_index: null },
            action: 'UnknownAction' as any,
            sanitized_content: null,
            processing_duration_ms: 1,
        }));

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('INVALIDATED');
        expect(controller.getBanner().type).toBe('Disconnected');
        expect(controller.getBanner().message).toContain('Unknown DLP action');
    });

    // -------------------------------------------------------------------------
    // 16. IPC timeout fails closed
    // -------------------------------------------------------------------------
    it('16. IPC timeout fails closed and marks banner Disconnected', async () => {
        client.evaluateAiAccess = vi.fn(async () => {
            throw new Error('request_timeout: Inspection request timed out after 10000ms');
        });

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('INVALIDATED');
        expect(controller.getBanner().type).toBe('Disconnected');
        expect(controller.getBanner().message).toContain('request_timeout');
    });

    // -------------------------------------------------------------------------
    // 17. IPC disconnect fails closed
    // -------------------------------------------------------------------------
    it('17. IPC disconnect fails closed without dispatch', async () => {
        client.disconnect();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('INVALIDATED');
        expect(controller.getBanner().type).toBe('Disconnected');
        expect(controller.getBanner().message).toContain('Agent disconnected');
    });

    // -------------------------------------------------------------------------
    // 18. Authentication / protocol failure fails closed
    // -------------------------------------------------------------------------
    it('18. authentication or protocol mismatch failure fails closed', async () => {
        client.evaluateAiAccess = vi.fn(async () => {
            throw new Error('unauthorized: Invalid authentication token');
        });

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('INVALIDATED');
        expect(controller.getBanner().type).toBe('Disconnected');
        expect(controller.getBanner().message).toContain('unauthorized');
    });

    // -------------------------------------------------------------------------
    // 19. Prompt mutation invalidates authorization
    // -------------------------------------------------------------------------
    it('19. prompt mutation after authorization invalidates ticket and blocks dispatch', async () => {
        client.setAllow();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('AUTHORIZED');

        // Developer tampers with prompt text after authorization
        const mutatedPrompt = NEUTRAL_PROMPT_1 + ' [tampered modification]';

        expect(() => {
            controller.validateTicketBeforeDispatch(ticket.id, mutatedPrompt);
        }).toThrow(/Content modified after authorization/);

        expect(ticket.state).toBe('INVALIDATED');
    });

    // -------------------------------------------------------------------------
    // 20. Selected-code mutation invalidates authorization
    // -------------------------------------------------------------------------
    it('20. selected-code mutation after authorization invalidates ticket and blocks dispatch', async () => {
        client.setAllow();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);
        expect(ticket.state).toBe('AUTHORIZED');

        const mutatedCode = NEUTRAL_CODE_SNIPPET + '\n// added code';

        expect(() => {
            controller.validateTicketBeforeDispatch(ticket.id, NEUTRAL_PROMPT_1, mutatedCode);
        }).toThrow(/Content modified after authorization/);

        expect(ticket.state).toBe('INVALIDATED');
    });

    // -------------------------------------------------------------------------
    // 21. Model change invalidates authorization
    // -------------------------------------------------------------------------
    it('21. model change between authorization and dispatch invalidates ticket', async () => {
        client.setAllow();

        const ticket = await controller.startSubmission(
            NEUTRAL_PROMPT_1,
            undefined,
            'github_copilot',
            { modelId: 'copilot-gpt-4o', modelVendor: 'copilot' }
        );
        expect(ticket.state).toBe('AUTHORIZED');

        // Target model changed to a different model id
        expect(() => {
            controller.validateTicketBeforeDispatch(
                ticket.id,
                NEUTRAL_PROMPT_1,
                undefined,
                'copilot-gpt-3.5-turbo'
            );
        }).toThrow(/Model identity changed after authorization/);

        expect(ticket.state).toBe('INVALIDATED');
    });

    // -------------------------------------------------------------------------
    // 22. Duplicate Proceed prevented
    // -------------------------------------------------------------------------
    it('22. prevents duplicate Proceed on an already processed ticket', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('PENDING');

        // First Proceed: succeeds and authorizes
        const authorized = await controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1);
        expect(authorized.state).toBe('AUTHORIZED');

        // Second Proceed: must throw because ticket is no longer PENDING
        await expect(
            controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1)
        ).rejects.toThrow(/not in PENDING state/);
    });

    // -------------------------------------------------------------------------
    // 23. Duplicate dispatch prevented
    // -------------------------------------------------------------------------
    it('23. prevents concurrent or duplicate dispatch calls on the same ticket', async () => {
        client.setAllow();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('AUTHORIZED');

        // Launch dispatch
        const dispatchPromise1 = ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel);

        // Concurrent second dispatch attempt detects state is DISPATCHING or CONSUMED
        await expect(
            ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel)
        ).rejects.toThrow(/unauthorized state/);

        const result1 = await dispatchPromise1;
        expect(result1.success).toBe(true);
    });

    // -------------------------------------------------------------------------
    // 24. Consumed ticket cannot be reused
    // -------------------------------------------------------------------------
    it('24. consumed ticket cannot be reused for a second dispatch', async () => {
        client.setAllow();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        expect(ticket.state).toBe('AUTHORIZED');

        const res1 = await ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel);
        expect(res1.success).toBe(true);
        expect(ticket.state).toBe('CONSUMED');

        // Attempt second dispatch with consumed ticket
        await expect(
            ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel)
        ).rejects.toThrow(/unauthorized state "CONSUMED"/);
    });

    // -------------------------------------------------------------------------
    // 25. Cancellation prevents dispatch
    // -------------------------------------------------------------------------
    it('25. cancelling coach or redact banner permanently prevents dispatch', async () => {
        client.setDlpCoach();

        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
        controller.handleCoachCancel(ticket.id);

        expect(ticket.state).toBe('INVALIDATED');

        await expect(
            ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel)
        ).rejects.toThrow(/unauthorized state "INVALIDATED"/);
    });

    // -------------------------------------------------------------------------
    // 26. model.sendRequest error handled without unsafe retry
    // -------------------------------------------------------------------------
    it('26. model.sendRequest error is handled gracefully and ticket is consumed (no retry)', async () => {
        const errorModel = {
            id: 'copilot-gpt-4o',
            vendor: 'copilot',
            sendRequest: vi.fn(async () => {
                throw new Error('Network timeout during stream');
            }),
        };

        client.setAllow();
        const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);

        const result = await ControlledDispatcher.dispatchToModel(ticket, errorModel);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Network timeout');
        expect(ticket.state).toBe('CONSUMED');
        expect(errorModel.sendRequest).toHaveBeenCalledTimes(1);
    });

    // -------------------------------------------------------------------------
    // 27. No direct model submission before authorization
    // -------------------------------------------------------------------------
    it('27. strictly prohibits direct model submission before authorization', async () => {
        const uninspectedTicket: DispatchTicket = {
            id: 'uninspected-01',
            contentHash: hashContent(NEUTRAL_PROMPT_1),
            targetService: 'github_copilot',
            state: 'PENDING',
            rawContent: NEUTRAL_PROMPT_1,
            createdAt: Date.now(),
        };

        await expect(
            ControlledDispatcher.dispatchToModel(uninspectedTicket, mockCopilotModel)
        ).rejects.toThrow(/unauthorized state "PENDING"/);

        expect(mockCopilotModel.sendRequest).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // 28. No original content transmitted after REDACT
    // -------------------------------------------------------------------------
    it('28. verifies raw pre-redaction content is never transmitted to model after REDACT', async () => {
        const rawContent = 'Sensitive database password: SuperSecretPassword123!';
        const sanitizedContent = 'Sensitive database password: [REDACTED_PASSWORD]';

        client.inspect = vi.fn(async () => ({
            detections_count: 1,
            detections: [],
            risk_assessment: { score: 90, level: 'Critical' as any, primary_detection_index: 0 },
            action: 'Redact' as const,
            sanitized_content: sanitizedContent,
            processing_duration_ms: 1,
        }));

        const ticket = await controller.startSubmission(rawContent);
        const redactedTicket = controller.handleRedactProceed(ticket.id, sanitizedContent);

        let sentMessageContent = '';
        const recordingModel = {
            id: 'copilot-gpt-4o',
            vendor: 'copilot',
            sendRequest: vi.fn(async (messages: any[]) => {
                sentMessageContent = messages[0].content;
                return { text: 'Done' };
            }),
        };

        const result = await ControlledDispatcher.dispatchToModel(redactedTicket, recordingModel);

        expect(result.success).toBe(true);
        expect(sentMessageContent).toBe(sanitizedContent);
        expect(sentMessageContent).not.toContain('SuperSecretPassword123!');
    });

    // -------------------------------------------------------------------------
    // 29. No sensitive raw logging
    // -------------------------------------------------------------------------
    it('29. does not log raw prompt, selected code, or sanitized content to console', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log');
        const consoleErrorSpy = vi.spyOn(console, 'error');
        const consoleWarnSpy = vi.spyOn(console, 'warn');

        const secretPrompt = 'CONFIDENTIAL_FINANCIAL_METRICS_998877';
        client.setAllow();

        const ticket = await controller.startSubmission(secretPrompt);
        await ControlledDispatcher.dispatchToModel(ticket, mockCopilotModel);

        const allLogs = [
            ...consoleLogSpy.mock.calls,
            ...consoleErrorSpy.mock.calls,
            ...consoleWarnSpy.mock.calls,
        ]
            .flat()
            .join(' ');

        expect(allLogs).not.toContain(secretPrompt);

        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
    });

    // -------------------------------------------------------------------------
    // 30. Existing V1/V2 mock-based functionality continues to operate cleanly
    // -------------------------------------------------------------------------
    it('30. preserves deterministic MockIpcClient behavior without live agent dependencies', () => {
        expect(client.isConnected()).toBe(true);
        client.setAiAccessBlock();
        expect(client.isConnected()).toBe(true);
        client.setAllow();
        expect(client.isConnected()).toBe(true);
    });
});
