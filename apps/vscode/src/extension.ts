import * as vscode from 'vscode';
import { MockIpcClient } from './ipc/mock-client';
import { VsCodeEnforcementController } from './controller/enforcement-controller';
import { PromptViewProvider } from './ui/prompt-view-provider';
import { LmCapabilityProbe } from './model/probe';

let mockClient: MockIpcClient;
let controller: VsCodeEnforcementController;
let promptProvider: PromptViewProvider;

export function activate(context: vscode.ExtensionContext): void {
    // Initialize mock IPC client for V1 / Phase 1
    mockClient = new MockIpcClient();
    mockClient.setAllow(); // Default neutral Allow behavior

    // Initialize enforcement controller
    controller = new VsCodeEnforcementController(mockClient);

    // Register Webview View Provider for the controlled prompt composer
    promptProvider = new PromptViewProvider(controller);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PromptViewProvider.viewType,
            promptProvider
        )
    );

    // Register command: Open Prompt Composer
    context.subscriptions.push(
        vscode.commands.registerCommand('shadowshield.openComposer', async () => {
            await vscode.commands.executeCommand('shadowshield.promptView.focus');
        })
    );

    // Register command: Include Selected Code
    context.subscriptions.push(
        vscode.commands.registerCommand('shadowshield.includeSelection', () => {
            promptProvider.captureActiveEditorSelection();
        })
    );

    // Register command: Probe VS Code Language Model Capability
    context.subscriptions.push(
        vscode.commands.registerCommand('shadowshield.probeLmCapability', async () => {
            const outputChannel = vscode.window.createOutputChannel('ShadowShield LM Probe');
            outputChannel.show(true);
            outputChannel.appendLine('[ShadowShield] Initiating VS Code Language Model (vscode.lm) probe...');
            outputChannel.appendLine('[ShadowShield] Invariant: Strictly neutral text only. Zero secrets transmitted.');

            try {
                const probeResult = await LmCapabilityProbe.probe(vscode);
                outputChannel.appendLine(`[ShadowShield] Probe completed at: ${probeResult.testedAt}`);
                outputChannel.appendLine(`[ShadowShield] VS Code Version: ${probeResult.vscodeVersion}`);
                outputChannel.appendLine(`[ShadowShield] vscode.lm Available: ${probeResult.apiAvailable}`);
                outputChannel.appendLine(`[ShadowShield] Models Detected: ${probeResult.modelsFound}`);

                for (const m of probeResult.models) {
                    outputChannel.appendLine(`  - Model: ${m.name} (id: ${m.id}, vendor: ${m.vendor}, maxTokens: ${m.maxInputTokens})`);
                }

                outputChannel.appendLine(`[ShadowShield] User Consent Observed: ${probeResult.consentObserved}`);
                if (probeResult.probeOutput) {
                    outputChannel.appendLine(`[ShadowShield] Neutral Model Output: ${probeResult.probeOutput.trim()}`);
                }
                if (probeResult.error) {
                    outputChannel.appendLine(`[ShadowShield] Probe Error: ${probeResult.error}`);
                }

                outputChannel.appendLine('\nFacts:');
                probeResult.facts.forEach((f) => outputChannel.appendLine(`  • ${f}`));
                outputChannel.appendLine('\nAssumptions:');
                probeResult.assumptions.forEach((a) => outputChannel.appendLine(`  • ${a}`));

                vscode.window.showInformationMessage(
                    `ShadowShield LM Probe finished: ${probeResult.modelsFound} model(s) found. Consent: ${probeResult.consentObserved}`
                );
            } catch (err: any) {
                outputChannel.appendLine(`[ShadowShield] Fatal probe exception: ${err?.message || err}`);
                vscode.window.showErrorMessage(`ShadowShield LM Probe failed: ${err?.message || err}`);
            }
        })
    );
}

export function deactivate(): void {
    if (mockClient) {
        mockClient.disconnect();
    }
}

// Export for unit tests
export function _getInternalState() {
    return {
        mockClient,
        controller,
        promptProvider,
    };
}
