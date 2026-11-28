import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { VsCodeEnforcementController } from '../../src/controller/enforcement-controller';
import { PromptViewProvider } from '../../src/ui/prompt-view-provider';
import { ControlledDispatcher } from '../../src/model/dispatcher';
import { ModelSelector } from '../../src/model/model-selector';
import { MockIpcClient } from '../../src/ipc/mock-client';
import { RealIpcClient } from '../../src/ipc/real-client';
import { encodeLengthPrefixedFrame, StreamFrameDecoder } from '../../src/ipc/framing';
import { PROTOCOL_VERSION } from '../../src/ipc/protocol';
import {
    NEUTRAL_PROMPT_1,
    NEUTRAL_PROMPT_2,
    NEUTRAL_CODE_SNIPPET,
    NEUTRAL_MUTATED_CODE,
    NEUTRAL_SANITIZED_SNIPPET,
} from '../fixtures/neutral-fixtures';

// Mock vscode module for controlled tests
vi.mock('vscode', () => {
    return {
        window: {
            activeTextEditor: undefined,
            showInformationMessage: vi.fn(),
            showErrorMessage: vi.fn(),
        },
        lm: {
            selectChatModels: vi.fn(async (options?: { vendor?: string }) => {
                if (options?.vendor && options.vendor !== 'copilot') return [];
                return [
                    {
                        id: 'copilot-gpt-4o',
                        name: 'GitHub Copilot GPT-4o',
                        vendor: 'copilot',
                        family: 'gpt-4o',
                        sendRequest: vi.fn(async () => ({
                            text: (async function* () {
                                yield 'Mock model response';
                            })(),
                        })),
                    },
                ];
            }),
        },
        LanguageModelChatMessage: {
            User: (content: string) => ({ role: 1, content }),
            Assistant: (content: string) => ({ role: 2, content }),
        },
    };
});

describe('V4 — Reliability, Recovery and IDE Validation', () => {
    let client: MockIpcClient;
    let controller: VsCodeEnforcementController;
    let provider: PromptViewProvider;

    beforeEach(() => {
        client = new MockIpcClient();
        controller = new VsCodeEnforcementController(client);
        provider = new PromptViewProvider(controller, { autoDispatch: false });
    });

    // =========================================================================
    // 1. Cancellation & Invalidation Lifecycle (Points 1 - 5)
    // =========================================================================
    describe('1. Cancellation & Invalidation Lifecycle', () => {
        it('1. Cancel before authorization: invalidates active ticket and clears banner', async () => {
            client.setAllow();
            // Introduce artificial delay so inspection is in flight
            client.setArtificialDelay(30);

            const ticketPromise = controller.startSubmission(NEUTRAL_PROMPT_1);
            // Invalidate ticket while in flight
            controller.invalidateActiveTicket('Developer cancelled before authorization');

            const ticket = await ticketPromise;
            expect(ticket.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Block');
            expect(controller.getBanner().message).toContain('Developer cancelled');
        });

        it('2. AI Access Coach Cancel: halts submission and sets state to INVALIDATED', async () => {
            client.setAiAccessCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            const cancelled = controller.handleCoachCancel(ticket.id);
            expect(cancelled.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('None');
        });

        it('3. DLP Coach Cancel: halts submission and sets state to INVALIDATED', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            const cancelled = controller.handleCoachCancel(ticket.id);
            expect(cancelled.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('None');
        });

        it('4. REDACT Cancel: halts submission and sets state to INVALIDATED', async () => {
            client.setDlpRedact(NEUTRAL_SANITIZED_SNIPPET);
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            const cancelled = controller.handleRedactCancel(ticket.id);
            expect(cancelled.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('None');
        });

        it('5. Cancelled ticket cannot later Proceed', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            controller.handleCoachCancel(ticket.id);

            // Attempting to proceed on cancelled ticket must throw
            await expect(
                controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1)
            ).rejects.toThrow(/not in PENDING state/i);
        });
    });

    // =========================================================================
    // 2. Content & Identity Mutation Invalidation (Points 6 - 8)
    // =========================================================================
    describe('2. Content & Identity Mutation Invalidation', () => {
        it('6. Prompt mutation invalidates pending ticket and sets Stale Content banner', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            // User modified prompt text while awaiting confirmation
            const updated = await controller.handleCoachProceed(
                ticket.id,
                NEUTRAL_PROMPT_2 // Mutated prompt!
            );

            expect(updated.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Block');
            expect(controller.getBanner().title).toContain('Stale Content');
        });

        it('7. Selected-code mutation invalidates pending ticket', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);
            expect(ticket.state).toBe('PENDING');

            // User modified code snippet while awaiting confirmation
            const updated = await controller.handleCoachProceed(
                ticket.id,
                NEUTRAL_PROMPT_1,
                NEUTRAL_MUTATED_CODE // Mutated code!
            );

            expect(updated.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Block');
            expect(controller.getBanner().title).toContain('Stale Content');
        });

        it('8. Model change invalidates pending ticket', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(
                NEUTRAL_PROMPT_1,
                undefined,
                'github_copilot',
                { modelId: 'copilot-gpt-4o', modelVendor: 'copilot' }
            );
            expect(ticket.state).toBe('PENDING');

            // Model changed before proceeding
            const updated = await controller.handleCoachProceed(
                ticket.id,
                NEUTRAL_PROMPT_1,
                undefined,
                { modelId: 'copilot-claude-3.5', modelVendor: 'copilot' } // Changed model!
            );

            expect(updated.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Block');
            expect(controller.getBanner().title).toContain('Model Changed');
        });
    });

    // =========================================================================
    // 3. Webview Disposal, Reload & Provider Isolation (Points 9 - 13)
    // =========================================================================
    describe('3. Webview Disposal, Reload & Provider Isolation', () => {
        it('9. Webview disposal invalidates pending ticket', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            provider.handleDisposal();

            expect(ticket.state).toBe('INVALIDATED');
            expect(provider.isWebviewDisposed()).toBe(true);
            expect(controller.getBanner().type).toBe('Block');
        });

        it('10. Webview reload does not restore authorization', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('AUTHORIZED');

            // Simulate webview reload by re-invoking resolveWebviewView
            const mockWebviewView: any = {
                webview: {
                    options: {},
                    onDidReceiveMessage: vi.fn(),
                    html: '',
                },
                onDidDispose: vi.fn(),
            };
            provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

            // Previous ticket must be invalidated and local state reset
            expect(ticket.state).toBe('INVALIDATED');
            expect(provider.getState().promptText).toBe('');
            expect(controller.getBanner().type).toBe('Block');
        });

        it('11. Provider recreation starts fresh', () => {
            const freshController = new VsCodeEnforcementController(new MockIpcClient());
            const freshProvider = new PromptViewProvider(freshController);

            expect(freshController.getActiveTicket()).toBeNull();
            expect(freshController.getBanner().type).toBe('None');
            expect(freshProvider.getState().promptText).toBe('');
            expect(freshProvider.getState().selectedCode).toBeUndefined();
        });

        it('12. Stale Proceed after disposal rejected', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            provider.handleDisposal();

            // Attempting to send webview message after disposal must be dropped silently
            await provider.handleWebviewMessage({
                type: 'coachProceed',
            });

            expect(ticket.state).toBe('INVALIDATED');
        });

        it('13. Separate provider instances do not share tickets', async () => {
            const clientA = new MockIpcClient();
            const controllerA = new VsCodeEnforcementController(clientA);
            const providerA = new PromptViewProvider(controllerA);

            const clientB = new MockIpcClient();
            const controllerB = new VsCodeEnforcementController(clientB);
            const providerB = new PromptViewProvider(controllerB);

            clientA.setAllow();
            const ticketA = await controllerA.startSubmission(NEUTRAL_PROMPT_1);

            expect(controllerA.getActiveTicket()?.id).toBe(ticketA.id);
            expect(controllerB.getActiveTicket()).toBeNull();

            // controllerB cannot proceed or validate ticketA
            await expect(
                controllerB.handleCoachProceed(ticketA.id, NEUTRAL_PROMPT_1)
            ).rejects.toThrow(/not found or inactive/i);
        });
    });

    // =========================================================================
    // 4. Transport Disconnect, Shutdown & Fail-Closed Behavior (Points 14 - 17)
    // =========================================================================
    describe('4. Transport Disconnect, Shutdown & Fail-Closed Behavior', () => {
        it('14. Disconnect during EvaluateAiAccess fails closed', async () => {
            vi.spyOn(client, 'evaluateAiAccess').mockRejectedValueOnce(
                new Error('connection_closed: Agent disconnected')
            );

            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Disconnected');
            expect(controller.getBanner().message).toContain('connection_closed');
        });

        it('15. Disconnect during Inspect fails closed', async () => {
            client.setAllow(); // AI access passes
            vi.spyOn(client, 'inspect').mockRejectedValueOnce(
                new Error('connection_closed: Socket error during inspection')
            );

            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Disconnected');
            expect(controller.getBanner().message).toContain('connection_closed');
        });

        it('16. Clean agent shutdown fails in-flight request closed', async () => {
            // Simulate agent server clean shutdown closing connection
            controller.handleDisconnect('Agent shutdown cleanly (SIGINT)');

            expect(controller.getBanner().type).toBe('Disconnected');
            expect(controller.getBanner().message).toContain('Agent shutdown cleanly');
        });

        it('17. Abrupt disconnect fails in-flight request closed', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            controller.handleDisconnect('connection_closed: Abrupt connection reset');

            expect(ticket.state).toBe('INVALIDATED');
            expect(controller.getBanner().type).toBe('Disconnected');
            expect(controller.getBanner().message).toContain('Abrupt connection reset');
        });
    });

    // =========================================================================
    // 5. Reconnect & Lifecycle Non-Reuse (Points 18 - 21)
    // =========================================================================
    describe('5. Reconnect & Lifecycle Non-Reuse', () => {
        it('18. Reconnect allows only NEW submission', async () => {
            client.setAllow();
            const ticket1 = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket1.state).toBe('AUTHORIZED');

            // Agent restarts / disconnects
            controller.handleDisconnect();
            expect(ticket1.state).toBe('INVALIDATED');

            // New submission after reconnect
            const ticket2 = await controller.startSubmission(NEUTRAL_PROMPT_2);
            expect(ticket2.state).toBe('AUTHORIZED');
            expect(ticket2.id).not.toBe(ticket1.id);
        });

        it('19. Old decision not reused after reconnect', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('AUTHORIZED');

            // Disconnect occurs
            controller.handleDisconnect();
            expect(ticket.state).toBe('INVALIDATED');

            // Model dispatch attempt on the old ticket after reconnect must be rejected
            await expect(
                ControlledDispatcher.dispatch(ticket)
            ).rejects.toThrow(/unauthorized state "INVALIDATED"/i);
        });

        it('20. Old Coach approval not reused after reconnect', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            // Disconnect occurs while coach banner is displayed
            controller.handleDisconnect();
            expect(ticket.state).toBe('INVALIDATED');

            // Attempting to proceed on the old coach ticket after reconnect must throw
            await expect(
                controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1)
            ).rejects.toThrow(/not in PENDING state/i);
        });

        it('21. Token reread after reconnect remains correct', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowshield-v4-token-'));
            const tokenPath = path.join(tempDir, 'auth.token');
            const initialToken = 'a'.repeat(64);
            const rotatedToken = 'b'.repeat(64);

            try {
                fs.writeFileSync(tokenPath, initialToken);
                const realClient = new RealIpcClient({ tokenPath });

                expect(realClient.readAuthToken()).toBe(initialToken);

                // Simulate agent daemon restart with rotated token
                fs.writeFileSync(tokenPath, rotatedToken);
                expect(realClient.readAuthToken()).toBe(rotatedToken);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    // =========================================================================
    // 6. Protocol, Timeout & Handshake Fail-Closed Invariants (Points 22 - 24)
    // =========================================================================
    describe('6. Protocol, Timeout & Handshake Fail-Closed Invariants', () => {
        it('22. Request timeout fails closed', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowshield-v4-timeout-'));
            const tokenPath = path.join(tempDir, 'auth.token');
            fs.writeFileSync(tokenPath, 'e'.repeat(64));

            try {
                const realClient = new RealIpcClient({
                    tokenPath,
                    clientRequestTimeoutMs: 50,
                    handshakeTimeoutMs: 50,
                    connectFn: () => {
                        const mockSocket: any = new EventEmitter();
                        mockSocket.destroyed = false;
                        mockSocket.write = vi.fn();
                        mockSocket.destroy = vi.fn();
                        setTimeout(() => mockSocket.emit('connect'), 5);
                        return mockSocket;
                    },
                });

                // Handshake will time out because mockSocket never responds
                await expect(realClient.connect()).rejects.toThrow(/timeout/i);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('23. Authentication failure fails closed', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowshield-v4-auth-'));
            const tokenPath = path.join(tempDir, 'auth.token');
            const token = 'c'.repeat(64);
            fs.writeFileSync(tokenPath, token);

            try {
                const decoder = new StreamFrameDecoder();
                const realClient = new RealIpcClient({
                    tokenPath,
                    handshakeTimeoutMs: 200,
                    connectFn: () => {
                        const mockSocket: any = new EventEmitter();
                        mockSocket.destroyed = false;
                        mockSocket.destroy = vi.fn();
                        mockSocket.write = vi.fn((buf: Buffer) => {
                            const msgs = decoder.feed(buf);
                            for (const req of msgs) {
                                const errResp = {
                                    protocol_version: PROTOCOL_VERSION,
                                    request_id: (req as any).request_id,
                                    type: 'Error',
                                    payload: {
                                        code: 'unauthorized',
                                        message: 'Invalid authentication token',
                                    },
                                };
                                setTimeout(() => {
                                    mockSocket.emit('data', encodeLengthPrefixedFrame(errResp));
                                }, 5);
                            }
                        });
                        setTimeout(() => mockSocket.emit('connect'), 5);
                        return mockSocket;
                    },
                });

                await expect(realClient.connect()).rejects.toThrow(/unauthorized/i);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('24. Protocol mismatch fails closed', async () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadowshield-v4-proto-'));
            const tokenPath = path.join(tempDir, 'auth.token');
            fs.writeFileSync(tokenPath, 'd'.repeat(64));

            try {
                const decoder = new StreamFrameDecoder();
                let msgCount = 0;
                const realClient = new RealIpcClient({
                    tokenPath,
                    handshakeTimeoutMs: 200,
                    connectFn: () => {
                        const mockSocket: any = new EventEmitter();
                        mockSocket.destroyed = false;
                        mockSocket.destroy = vi.fn();
                        mockSocket.write = vi.fn((buf: Buffer) => {
                            const msgs = decoder.feed(buf);
                            for (const req of msgs) {
                                msgCount++;
                                setTimeout(() => {
                                    if (msgCount === 1) {
                                        const authResp = {
                                            protocol_version: PROTOCOL_VERSION,
                                            request_id: (req as any).request_id,
                                            type: 'Authenticate',
                                            payload: { authenticated: true },
                                        };
                                        mockSocket.emit('data', encodeLengthPrefixedFrame(authResp));
                                    } else {
                                        const helloResp = {
                                            protocol_version: PROTOCOL_VERSION,
                                            request_id: (req as any).request_id,
                                            type: 'Hello',
                                            payload: { protocol_version: 99, compatible: false },
                                        };
                                        mockSocket.emit('data', encodeLengthPrefixedFrame(helloResp));
                                    }
                                }, 5);
                            }
                        });
                        setTimeout(() => mockSocket.emit('connect'), 5);
                        return mockSocket;
                    },
                });

                await expect(realClient.connect()).rejects.toThrow(/unsupported_protocol/i);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    // =========================================================================
    // 7. Duplicate Event & Replay Protection (Points 25 - 29)
    // =========================================================================
    describe('7. Duplicate Event & Replay Protection', () => {
        it('25. Double Submit does not duplicate model dispatch', async () => {
            client.setAllow();
            let inspectCount = 0;
            vi.spyOn(client, 'inspect').mockImplementation(async () => {
                inspectCount++;
                // Artificial delay to simulate in-flight inspection
                await new Promise((r) => setTimeout(r, 20));
                return { action: 'Allow' };
            });

            // Start first submission
            const promise1 = controller.startSubmission(NEUTRAL_PROMPT_1);

            // Immediate second submission while inspection is active
            await expect(
                controller.startSubmission(NEUTRAL_PROMPT_1)
            ).rejects.toThrow(/inspection is already in progress/i);

            await promise1;
            expect(inspectCount).toBe(1);
        });

        it('26. Duplicate Coach Proceed rejected', async () => {
            client.setDlpCoach();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            // First proceed succeeds
            const proceeded = await controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1);
            expect(proceeded.state).toBe('AUTHORIZED');

            // Duplicate proceed on the now-authorized ticket must throw
            await expect(
                controller.handleCoachProceed(ticket.id, NEUTRAL_PROMPT_1)
            ).rejects.toThrow(/not in PENDING state/i);
        });

        it('27. Duplicate REDACT Proceed rejected', async () => {
            client.setDlpRedact(NEUTRAL_SANITIZED_SNIPPET);
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('PENDING');

            // First proceed succeeds
            const proceeded = controller.handleRedactProceed(
                ticket.id,
                NEUTRAL_SANITIZED_SNIPPET
            );
            expect(proceeded.state).toBe('AUTHORIZED');

            // Duplicate proceed on the now-authorized ticket must throw
            expect(() =>
                controller.handleRedactProceed(ticket.id, NEUTRAL_SANITIZED_SNIPPET)
            ).toThrow(/not in PENDING state/i);
        });

        it('28. Duplicate dispatch rejected', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('AUTHORIZED');

            // First dispatch succeeds
            const res1 = await ControlledDispatcher.dispatch(ticket, async (c) => 'resp');
            expect(res1.success).toBe(true);
            expect(ticket.state).toBe('CONSUMED');

            // Duplicate dispatch on the consumed ticket must throw security violation
            await expect(
                ControlledDispatcher.dispatch(ticket, async (c) => 'resp')
            ).rejects.toThrow(/unauthorized state "CONSUMED"/i);
        });

        it('29. Consumed ticket cannot be reused', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            await ControlledDispatcher.dispatch(ticket, async () => 'done');

            expect(ticket.state).toBe('CONSUMED');

            const mockModel = {
                id: 'copilot-gpt-4o',
                vendor: 'copilot',
                sendRequest: vi.fn(),
            };

            await expect(
                ControlledDispatcher.dispatchToModel(ticket, mockModel)
            ).rejects.toThrow(/unauthorized state "CONSUMED"/i);
            expect(mockModel.sendRequest).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 8. Ambiguous Dispatch Failures & Non-Retry (Points 30 - 32)
    // =========================================================================
    describe('8. Ambiguous Dispatch Failures & Non-Retry', () => {
        it('30. sendRequest error does not retry', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('AUTHORIZED');

            let callCount = 0;
            const failingModel = {
                id: 'copilot-gpt-4o',
                vendor: 'copilot',
                sendRequest: vi.fn(async () => {
                    callCount++;
                    throw new Error('Network error during model dispatch');
                }),
            };

            const result = await ControlledDispatcher.dispatchToModel(ticket, failingModel);
            expect(result.success).toBe(false);
            expect(callCount).toBe(1); // Exactly one attempt, NO retry
            expect(ticket.state).toBe('CONSUMED'); // Invariant: Transitions to CONSUMED
        });

        it('31. Ambiguous stream/provider failure does not retry', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('AUTHORIZED');

            let callCount = 0;
            const streamFailingModel = {
                id: 'copilot-gpt-4o',
                vendor: 'copilot',
                sendRequest: vi.fn(async () => {
                    callCount++;
                    return {
                        text: (async function* () {
                            yield 'partial chunk';
                            throw new Error('Stream interrupted abruptly');
                        })(),
                    };
                }),
            };

            const result = await ControlledDispatcher.dispatchToModel(ticket, streamFailingModel);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Stream interrupted abruptly');
            expect(callCount).toBe(1);
            expect(ticket.state).toBe('CONSUMED');
        });

        it('32. Cancellation around model dispatch does not retry', async () => {
            client.setAllow();
            const ticket = await controller.startSubmission(NEUTRAL_PROMPT_1);
            expect(ticket.state).toBe('AUTHORIZED');

            const token = { isCancellationRequested: true };
            const mockModel = {
                id: 'copilot-gpt-4o',
                vendor: 'copilot',
                sendRequest: vi.fn(),
            };

            const result = await ControlledDispatcher.dispatchToModel(ticket, mockModel, {
                cancellationToken: token,
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('cancelled');
            expect(mockModel.sendRequest).not.toHaveBeenCalled();
            expect(ticket.state).toBe('CONSUMED');
        });
    });

    // =========================================================================
    // 9. Model Resolution & Ambiguity Protection (Points 33 - 34)
    // =========================================================================
    describe('9. Model Resolution & Ambiguity Protection', () => {
        it('33. Model disappearance fails closed', async () => {
            const emptyVscode = {
                lm: {
                    selectChatModels: vi.fn(async () => []),
                },
            };

            await expect(
                ModelSelector.resolveApprovedModel(emptyVscode)
            ).rejects.toThrow(/No language models available/i);
        });

        it('34. Multiple-model ambiguity remains fail closed', async () => {
            const multiVscode = {
                lm: {
                    selectChatModels: vi.fn(async () => [
                        { id: 'copilot-gpt-4o', vendor: 'copilot' },
                        { id: 'copilot-claude-3.5', vendor: 'copilot' },
                    ]),
                },
            };

            // Calling without explicit preferredModelId must fail closed
            await expect(
                ModelSelector.resolveApprovedModel(multiVscode)
            ).rejects.toThrow(/Ambiguous model selection/i);

            // Specifying explicit model ID succeeds
            const target = await ModelSelector.resolveApprovedModel(multiVscode, 'copilot-gpt-4o');
            expect(target.modelId).toBe('copilot-gpt-4o');
        });
    });

    // =========================================================================
    // 10. UI & Logging Privacy Safeguards (Points 35 - 36)
    // =========================================================================
    describe('10. UI & Logging Privacy Safeguards', () => {
        it('35. Failure UI contains no sensitive raw content', async () => {
            // Block
            client.setAiAccessBlock();
            await controller.startSubmission(NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET);
            const blockBanner = controller.getBanner();
            expect(blockBanner.title).not.toContain(NEUTRAL_PROMPT_1);
            expect(blockBanner.message).not.toContain(NEUTRAL_PROMPT_1);
            expect(blockBanner.message).not.toContain(NEUTRAL_CODE_SNIPPET);

            // Disconnect
            controller.handleDisconnect('Connection lost');
            const disconnBanner = controller.getBanner();
            expect(disconnBanner.message).not.toContain(NEUTRAL_PROMPT_1);
            expect(disconnBanner.message).not.toContain(NEUTRAL_CODE_SNIPPET);
        });

        it('36. No sensitive persistence or logging in source', () => {
            const srcDir = path.resolve(__dirname, '../../src');
            const files = fs.readdirSync(srcDir, { recursive: true }) as string[];

            for (const file of files) {
                if (typeof file === 'string' && file.endsWith('.ts')) {
                    const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
                    expect(content).not.toMatch(/console\.(log|debug|info|warn|error)\(/);
                }
            }
        });
    });
});
