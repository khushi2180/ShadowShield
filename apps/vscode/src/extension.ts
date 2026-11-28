import * as vscode from 'vscode';
import { IIpcClient } from './ipc/client-interface';
import { MockIpcClient } from './ipc/mock-client';
import { RealIpcClient } from './ipc/real-client';
import { VsCodeEnforcementController } from './controller/enforcement-controller';
import { PromptViewProvider } from './ui/prompt-view-provider';
import { LmCapabilityProbe } from './model/probe';

export interface ExtensionActivationOptions {
    ipcClient?: IIpcClient;
    vscodeRef?: any;
}

let activeClient: IIpcClient;
let controller: VsCodeEnforcementController;
let promptProvider: PromptViewProvider;

export function activate(
    context: vscode.ExtensionContext,
    options?: ExtensionActivationOptions
): void {
    const vscodeRef = options?.vscodeRef || (typeof vscode !== 'undefined' ? vscode : null);

    // In production, instantiate the approved RealIpcClient (macOS UDS transport).
    // Invariant: NEVER automatically fall back to MockIpcClient in production.
    // Unit tests may explicitly inject an ipcClient via options.ipcClient.
    activeClient = options?.ipcClient || new RealIpcClient();

    // Initialize enforcement controller
    controller = new VsCodeEnforcementController(activeClient);

    // Register Webview View Provider for the controlled prompt composer
    promptProvider = new PromptViewProvider(controller, {
        vscodeRef,
        autoDispatch: true,
    });
    if (vscodeRef?.window?.registerWebviewViewProvider) {
        context.subscriptions.push(
            vscodeRef.window.registerWebviewViewProvider(
                PromptViewProvider.viewType,
                promptProvider
            )
        );
    }

    // Register command: Open Prompt Composer
    if (vscodeRef?.commands?.registerCommand) {
        context.subscriptions.push(
            vscodeRef.commands.registerCommand('shadowshield.openComposer', async () => {
                await vscodeRef.commands.executeCommand('shadowshield.promptView.focus');
            })
        );

        // Register command: Include Selected Code
        context.subscriptions.push(
            vscodeRef.commands.registerCommand('shadowshield.includeSelection', () => {
                promptProvider.captureActiveEditorSelection();
            })
        );

        // Register command: Probe VS Code Language Model Capability
        context.subscriptions.push(
            vscodeRef.commands.registerCommand('shadowshield.probeLmCapability', async () => {
                const outputChannel = vscodeRef.window.createOutputChannel('ShadowShield LM Probe');
                outputChannel.show(true);
                outputChannel.appendLine(
                    '[ShadowShield] Initiating VS Code Language Model (vscode.lm) probe...'
                );
                outputChannel.appendLine(
                    '[ShadowShield] Invariant: Strictly neutral text only. Zero secrets transmitted.'
                );

                try {
                    const probeResult = await LmCapabilityProbe.probe(vscodeRef);
                    outputChannel.appendLine(`[ShadowShield] Probe completed at: ${probeResult.testedAt}`);
                    outputChannel.appendLine(`[ShadowShield] VS Code Version: ${probeResult.vscodeVersion}`);
                    outputChannel.appendLine(`[ShadowShield] vscode.lm Available: ${probeResult.apiAvailable}`);
                    outputChannel.appendLine(`[ShadowShield] Models Detected: ${probeResult.modelsFound}`);

                    for (const m of probeResult.models) {
                        outputChannel.appendLine(
                            `  - Model: ${m.name} (id: ${m.id}, vendor: ${m.vendor}, maxTokens: ${m.maxInputTokens})`
                        );
                    }

                    outputChannel.appendLine(
                        `[ShadowShield] User Consent Observed: ${probeResult.consentObserved}`
                    );
                    if (probeResult.probeOutput) {
                        outputChannel.appendLine(
                            `[ShadowShield] Neutral Model Output: ${probeResult.probeOutput.trim()}`
                        );
                    }
                    if (probeResult.error) {
                        outputChannel.appendLine(`[ShadowShield] Probe Error: ${probeResult.error}`);
                    }

                    outputChannel.appendLine('\nFacts:');
                    probeResult.facts.forEach((f) => outputChannel.appendLine(`  • ${f}`));
                    outputChannel.appendLine('\nAssumptions:');
                    probeResult.assumptions.forEach((a) => outputChannel.appendLine(`  • ${a}`));

                    vscodeRef.window.showInformationMessage(
                        `ShadowShield LM Probe finished: ${probeResult.modelsFound} model(s) found. Consent: ${probeResult.consentObserved}`
                    );
                } catch (err: any) {
                    outputChannel.appendLine(
                        `[ShadowShield] Fatal probe exception: ${err?.message || err}`
                    );
                    vscodeRef.window.showErrorMessage(
                        `ShadowShield LM Probe failed: ${err?.message || err}`
                    );
                }
            })
        );
    }
}

export function deactivate(): void {
    if (activeClient) {
        activeClient.disconnect();
    }
}

// Export for unit tests
export function _getInternalState() {
    return {
        client: activeClient,
        mockClient: activeClient instanceof MockIpcClient ? activeClient : undefined,
        controller,
        promptProvider,
    };
}
