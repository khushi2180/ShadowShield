/**
 * VS Code Language Model (vscode.lm) Capability Probe.
 *
 * Separately probes the vscode.lm capability using strictly NEUTRAL TEXT ONLY.
 * Records actual model/vendor identity, consent behavior, VS Code version,
 * and availability observed without making unsupported assumptions.
 */

export interface LmModelInfo {
    id: string;
    name: string;
    vendor: string;
    family: string;
    maxInputTokens: number;
}

export interface LmProbeResult {
    testedAt: string;
    vscodeVersion: string;
    apiAvailable: boolean;
    modelsFound: number;
    models: LmModelInfo[];
    consentObserved: 'NotAttempted' | 'Granted' | 'Denied' | 'Unavailable' | 'Error';
    probeOutput?: string;
    error?: string;
    facts: string[];
    assumptions: string[];
}

export class LmCapabilityProbe {
    /**
     * Executes the capability probe against the provided vscode namespace.
     * Uses only neutral text ("Hello, please respond with OK.") - zero secrets or credentials.
     */
    public static async probe(vscodeRef: any): Promise<LmProbeResult> {
        const testedAt = new Date().toISOString();
        const vscodeVersion = vscodeRef?.version || 'unknown';
        const facts: string[] = [];
        const assumptions: string[] = [];

        // Fact 1: Check presence of vscode.lm namespace
        const apiAvailable = typeof vscodeRef?.lm !== 'undefined';
        facts.push(`vscode.lm namespace presence: ${apiAvailable}`);

        if (!apiAvailable) {
            assumptions.push('vscode.lm API is unavailable in this environment (requires VS Code >= 1.90.0)');
            return {
                testedAt,
                vscodeVersion,
                apiAvailable: false,
                modelsFound: 0,
                models: [],
                consentObserved: 'Unavailable',
                error: 'vscode.lm is undefined in the current extension host environment',
                facts,
                assumptions,
            };
        }

        try {
            // Fact 2: Query available chat models without assuming vendor
            const allModels: any[] = await vscodeRef.lm.selectChatModels();
            const modelsFound = Array.isArray(allModels) ? allModels.length : 0;
            facts.push(`selectChatModels() returned ${modelsFound} models`);

            const models: LmModelInfo[] = (allModels || []).map((m: any) => ({
                id: m?.id || 'unknown',
                name: m?.name || 'unknown',
                vendor: m?.vendor || 'unknown',
                family: m?.family || 'unknown',
                maxInputTokens: m?.maxInputTokens || 0,
            }));

            if (models.length === 0) {
                assumptions.push('No language models are registered. GitHub Copilot extension may be missing or unauthenticated.');
                return {
                    testedAt,
                    vscodeVersion,
                    apiAvailable: true,
                    modelsFound: 0,
                    models: [],
                    consentObserved: 'Unavailable',
                    facts,
                    assumptions,
                };
            }

            // Fact 3: Select preferred model (copilot vendor preferred, else first available)
            const targetModel = allModels.find((m: any) => m.vendor === 'copilot') || allModels[0];
            facts.push(`Selected model for neutral probe: id=${targetModel.id}, vendor=${targetModel.vendor}`);

            // Fact 4: Send strictly neutral probe text
            // Invariant: Do not send security fixture contents to an external model.
            const neutralProbeText = 'Hello, please respond with OK.';

            let consentObserved: LmProbeResult['consentObserved'] = 'NotAttempted';
            let probeOutput: string | undefined;

            try {
                // If model has sendRequest
                if (typeof targetModel.sendRequest === 'function') {
                    // Send neutral message
                    const messages = [
                        vscodeRef.LanguageModelChatMessage?.User?.(neutralProbeText) || {
                            role: 1, // User role in VS Code LM API
                            content: neutralProbeText,
                        },
                    ];

                    const response = await targetModel.sendRequest(messages, {}, new vscodeRef.CancellationTokenSource().token);
                    consentObserved = 'Granted';
                    facts.push('User consent granted and model request initiated');

                    // Read chunks if response.text is an async iterable
                    let collectedText = '';
                    if (response && response.text && Symbol.asyncIterator in response.text) {
                        for await (const chunk of response.text) {
                            collectedText += chunk;
                        }
                    } else if (typeof response?.text === 'string') {
                        collectedText = response.text;
                    }
                    probeOutput = collectedText || '[Response received with empty text]';
                    facts.push(`Model responded with output length: ${probeOutput.length}`);
                } else {
                    consentObserved = 'NotAttempted';
                    facts.push('targetModel does not expose sendRequest method');
                }
            } catch (sendErr: any) {
                const errMsg = sendErr?.message || String(sendErr);
                if (errMsg.toLowerCase().includes('denied') || errMsg.toLowerCase().includes('consent')) {
                    consentObserved = 'Denied';
                    facts.push('User or environment denied consent for Language Model API');
                } else {
                    consentObserved = 'Error';
                    facts.push(`Model probe sendRequest failed: ${errMsg}`);
                }
            }

            return {
                testedAt,
                vscodeVersion,
                apiAvailable: true,
                modelsFound,
                models,
                consentObserved,
                probeOutput,
                facts,
                assumptions,
            };
        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            facts.push(`selectChatModels threw error: ${errorMsg}`);
            return {
                testedAt,
                vscodeVersion,
                apiAvailable: true,
                modelsFound: 0,
                models: [],
                consentObserved: 'Error',
                error: errorMsg,
                facts,
                assumptions,
            };
        }
    }
}
