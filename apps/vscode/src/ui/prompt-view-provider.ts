import * as vscode from 'vscode';
import { VsCodeEnforcementController } from '../controller/enforcement-controller';
import { DispatchTicket, WebviewState } from '../controller/types';
import { ControlledDispatcher } from '../model/dispatcher';
import { ModelSelector, VerifiedModelTarget } from '../model/model-selector';
import { getWebviewHtml } from './webview-html';

export class PromptViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shadowshield.promptView';

    private view?: vscode.WebviewView;
    private controller: VsCodeEnforcementController;
    private vscodeRef: any;

    private state: WebviewState = {
        promptText: '',
        selectedService: 'github_copilot',
        banner: { type: 'None' },
        isInspecting: false,
    };

    private autoDispatch: boolean;

    constructor(
        controller: VsCodeEnforcementController,
        optionsOrVscodeRef?: any
    ) {
        this.controller = controller;
        if (optionsOrVscodeRef && typeof optionsOrVscodeRef === 'object') {
            if ('autoDispatch' in optionsOrVscodeRef) {
                this.autoDispatch = !!optionsOrVscodeRef.autoDispatch;
                this.vscodeRef = optionsOrVscodeRef.vscodeRef || vscode;
            } else {
                this.vscodeRef = optionsOrVscodeRef;
                this.autoDispatch = false;
            }
        } else {
            this.vscodeRef = typeof vscode !== 'undefined' ? vscode : null;
            this.autoDispatch = false;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };

        this.updateView();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            await this.handleWebviewMessage(message);
        });
    }

    public getState(): WebviewState {
        return { ...this.state };
    }

    public captureActiveEditorSelection(): void {
        const editor = this.vscodeRef?.window?.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            this.vscodeRef?.window?.showInformationMessage(
                'No active code selection found in editor.'
            );
            return;
        }

        const selectedText = editor.document.getText(editor.selection);
        this.state.selectedCode = selectedText;
        this.state.activeFile = editor.document.fileName.split(/[\\/]/).pop() || 'Editor';
        this.state.languageId = editor.document.languageId;
        this.updateView();
    }

    public clearSelection(): void {
        this.state.selectedCode = undefined;
        this.state.activeFile = undefined;
        this.state.languageId = undefined;
        this.updateView();
    }

    public updateView(): void {
        if (!this.view) return;
        this.state.banner = this.controller.getBanner();
        this.state.isInspecting = this.controller.isBusy();
        this.view.webview.html = getWebviewHtml(this.state);
    }

    public async executeDispatch(ticket: DispatchTicket, targetModel: any): Promise<void> {
        try {
            const result = await ControlledDispatcher.dispatchToModel(ticket, targetModel, {
                vscodeRef: this.vscodeRef,
            });

            if (result.success && result.output) {
                this.state.lastResponse = result.output;
                this.controller.setBanner({
                    type: 'Allow',
                    title: 'Response Received',
                    message: `Response from ${result.destinationService} received successfully.`,
                });
            } else if (!result.success) {
                this.controller.setBanner({
                    type: 'Disconnected',
                    title: 'Dispatch Failed',
                    message: result.error || 'Failed to dispatch request to language model.',
                });
            }
        } catch (err: any) {
            this.controller.setBanner({
                type: 'Disconnected',
                title: 'Dispatch Error',
                message: err?.message || 'Error during language model dispatch.',
            });
        }
    }

    public async handleWebviewMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'submit': {
                this.state.promptText = message.prompt || '';
                this.state.selectedService = message.serviceId || 'github_copilot';
                const intendedModelId = message.modelId || this.state.selectedModelId;
                this.updateView();

                let verifiedTarget: VerifiedModelTarget | undefined;
                try {
                    verifiedTarget = await ModelSelector.resolveApprovedModel(
                        this.vscodeRef,
                        intendedModelId
                    );
                } catch (err: any) {
                    this.controller.setBanner({
                        type: 'Disconnected',
                        title: 'Protection Unavailable (Fail Closed)',
                        message: err?.message || 'Language model resolution failed',
                    });
                    this.updateView();
                    return;
                }

                try {
                    const ticket = await this.controller.startSubmission(
                        this.state.promptText,
                        this.state.selectedCode,
                        verifiedTarget.serviceId,
                        { modelId: verifiedTarget.modelId, modelVendor: verifiedTarget.vendor }
                    );

                    if (this.autoDispatch && ticket.state === 'AUTHORIZED') {
                        await this.executeDispatch(ticket, verifiedTarget.model);
                    }
                } catch (err: any) {
                    this.controller.setBanner({
                        type: 'Disconnected',
                        title: 'Submission Error',
                        message: err?.message || 'Submission error',
                    });
                }
                this.updateView();
                break;
            }

            case 'captureSelection': {
                this.captureActiveEditorSelection();
                break;
            }

            case 'clearSelection': {
                this.clearSelection();
                break;
            }

            case 'clearPrompt': {
                this.state.promptText = '';
                this.controller.clearBanner();
                this.updateView();
                break;
            }

            case 'coachCancel': {
                const ticket = this.controller.getActiveTicket();
                if (ticket) {
                    this.controller.handleCoachCancel(ticket.id);
                }
                this.updateView();
                break;
            }

            case 'coachProceed': {
                const ticket = this.controller.getActiveTicket();
                if (ticket) {
                    try {
                        const verifiedTarget = await ModelSelector.resolveApprovedModel(
                            this.vscodeRef,
                            ticket.modelId
                        );

                        const updatedTicket = await this.controller.handleCoachProceed(
                            ticket.id,
                            this.state.promptText,
                            this.state.selectedCode,
                            { modelId: verifiedTarget.modelId, modelVendor: verifiedTarget.vendor }
                        );

                        if (this.autoDispatch && updatedTicket.state === 'AUTHORIZED') {
                            await this.executeDispatch(updatedTicket, verifiedTarget.model);
                        }
                    } catch (err: any) {
                        this.controller.setBanner({
                            type: 'Disconnected',
                            title: 'Protection Unavailable (Fail Closed)',
                            message: err?.message || 'Coach proceed error',
                        });
                    }
                }
                this.updateView();
                break;
            }

            case 'redactCancel': {
                const ticket = this.controller.getActiveTicket();
                if (ticket) {
                    this.controller.handleRedactCancel(ticket.id);
                }
                this.updateView();
                break;
            }

            case 'redactProceed': {
                const ticket = this.controller.getActiveTicket();
                if (ticket && ticket.authorizedContent) {
                    try {
                        // Write sanitized text back into prompt
                        this.state.promptText = ticket.authorizedContent;

                        const verifiedTarget = await ModelSelector.resolveApprovedModel(
                            this.vscodeRef,
                            ticket.modelId
                        );

                        const updatedTicket = this.controller.handleRedactProceed(
                            ticket.id,
                            this.state.promptText,
                            this.state.selectedCode,
                            { modelId: verifiedTarget.modelId, modelVendor: verifiedTarget.vendor }
                        );

                        if (this.autoDispatch && updatedTicket.state === 'AUTHORIZED') {
                            await this.executeDispatch(updatedTicket, verifiedTarget.model);
                        }
                    } catch (err: any) {
                        this.controller.setBanner({
                            type: 'Disconnected',
                            title: 'Protection Unavailable (Fail Closed)',
                            message: err?.message || 'Redact proceed error',
                        });
                    }
                }
                this.updateView();
                break;
            }

            case 'clearBanner': {
                this.controller.clearBanner();
                this.updateView();
                break;
            }
        }
    }
}
