import * as vscode from 'vscode';
import { VsCodeEnforcementController } from '../controller/enforcement-controller';
import { WebviewState } from '../controller/types';
import { getWebviewHtml } from './webview-html';

export class PromptViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'shadowshield.promptView';

    private view?: vscode.WebviewView;
    private controller: VsCodeEnforcementController;

    private state: WebviewState = {
        promptText: '',
        selectedService: 'github_copilot',
        banner: { type: 'None' },
        isInspecting: false,
    };

    constructor(controller: VsCodeEnforcementController) {
        this.controller = controller;
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
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showInformationMessage('No active code selection found in editor.');
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

    private updateView(): void {
        if (!this.view) return;
        this.state.banner = this.controller.getBanner();
        this.state.isInspecting = this.controller.isBusy();
        this.view.webview.html = getWebviewHtml(this.state);
    }

    public async handleWebviewMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'submit': {
                this.state.promptText = message.prompt || '';
                this.state.selectedService = message.serviceId || 'github_copilot';
                this.updateView();

                try {
                    await this.controller.startSubmission(
                        this.state.promptText,
                        this.state.selectedCode,
                        this.state.selectedService
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(err?.message || 'Submission error');
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
                    await this.controller.handleCoachProceed(
                        ticket.id,
                        this.state.promptText,
                        this.state.selectedCode
                    );
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
                    // Write sanitized text back into prompt
                    this.state.promptText = ticket.authorizedContent;
                    this.controller.handleRedactProceed(ticket.id);
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
