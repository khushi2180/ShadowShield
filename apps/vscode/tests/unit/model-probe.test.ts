import { describe, it, expect, vi } from 'vitest';
import { LmCapabilityProbe } from '../../src/model/probe';

describe('LmCapabilityProbe — Language Model Capability Detection', () => {
    it('detects when vscode.lm is undefined in the extension host', async () => {
        const fakeVsCode = { version: '1.89.0' }; // No lm property

        const result = await LmCapabilityProbe.probe(fakeVsCode);

        expect(result.apiAvailable).toBe(false);
        expect(result.vscodeVersion).toBe('1.89.0');
        expect(result.modelsFound).toBe(0);
        expect(result.consentObserved).toBe('Unavailable');
        expect(result.error).toContain('vscode.lm is undefined');
        expect(result.facts.some((f) => f.includes('vscode.lm namespace presence: false'))).toBe(true);
        expect(result.assumptions.length).toBeGreaterThan(0);
    });

    it('probes available models and records vendor and metadata using neutral text', async () => {
        const mockModel = {
            id: 'copilot-gpt-4o',
            name: 'GitHub Copilot GPT-4o',
            vendor: 'copilot',
            family: 'gpt-4o',
            maxInputTokens: 128000,
            sendRequest: vi.fn(async (messages: any[]) => {
                // Verify neutral text was passed
                expect(messages[0].content).toBe('Hello, please respond with OK.');
                return {
                    text: (async function* () {
                        yield 'OK';
                    })(),
                };
            }),
        };

        const fakeVsCode = {
            version: '1.92.0',
            lm: {
                selectChatModels: vi.fn(async () => [mockModel]),
            },
            LanguageModelChatMessage: {
                User: (text: string) => ({ role: 1, content: text }),
            },
            CancellationTokenSource: class {
                token = {};
            },
        };

        const result = await LmCapabilityProbe.probe(fakeVsCode);

        expect(result.apiAvailable).toBe(true);
        expect(result.vscodeVersion).toBe('1.92.0');
        expect(result.modelsFound).toBe(1);
        expect(result.models[0].vendor).toBe('copilot');
        expect(result.models[0].id).toBe('copilot-gpt-4o');
        expect(result.consentObserved).toBe('Granted');
        expect(result.probeOutput).toBe('OK');
        expect(mockModel.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('records consent denial without failing the probe', async () => {
        const mockModel = {
            id: 'copilot-gpt-4o',
            name: 'GitHub Copilot GPT-4o',
            vendor: 'copilot',
            family: 'gpt-4o',
            maxInputTokens: 128000,
            sendRequest: vi.fn(async () => {
                throw new Error('User denied consent to use language model API');
            }),
        };

        const fakeVsCode = {
            version: '1.91.0',
            lm: {
                selectChatModels: vi.fn(async () => [mockModel]),
            },
            LanguageModelChatMessage: {
                User: (text: string) => ({ role: 1, content: text }),
            },
            CancellationTokenSource: class {
                token = {};
            },
        };

        const result = await LmCapabilityProbe.probe(fakeVsCode);

        expect(result.apiAvailable).toBe(true);
        expect(result.consentObserved).toBe('Denied');
        expect(result.facts.some((f) => f.includes('denied consent'))).toBe(true);
    });

    it('reports zero models when no providers are installed', async () => {
        const fakeVsCode = {
            version: '1.90.0',
            lm: {
                selectChatModels: vi.fn(async () => []),
            },
        };

        const result = await LmCapabilityProbe.probe(fakeVsCode);

        expect(result.apiAvailable).toBe(true);
        expect(result.modelsFound).toBe(0);
        expect(result.consentObserved).toBe('Unavailable');
        expect(result.assumptions.some((a) => a.includes('No language models are registered'))).toBe(true);
    });
});
