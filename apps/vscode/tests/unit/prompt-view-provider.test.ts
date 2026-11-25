import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptViewProvider } from '../../src/ui/prompt-view-provider';
import { VsCodeEnforcementController } from '../../src/controller/enforcement-controller';
import { MockIpcClient } from '../../src/ipc/mock-client';
import { getWebviewHtml } from '../../src/ui/webview-html';
import { NEUTRAL_PROMPT_1, NEUTRAL_CODE_SNIPPET } from '../fixtures/neutral-fixtures';

// Mock vscode module
vi.mock('vscode', () => {
    return {
        window: {
            activeTextEditor: undefined,
            showInformationMessage: vi.fn(),
            showErrorMessage: vi.fn(),
        },
    };
});

describe('PromptViewProvider & Webview HTML Security', () => {
    let client: MockIpcClient;
    let controller: VsCodeEnforcementController;
    let provider: PromptViewProvider;

    beforeEach(() => {
        client = new MockIpcClient();
        controller = new VsCodeEnforcementController(client);
        provider = new PromptViewProvider(controller);
    });

    it('generates secure Content Security Policy in webview HTML', () => {
        const html = getWebviewHtml(provider.getState());

        // Invariant: strict CSP
        expect(html).toContain("default-src 'none'");
        expect(html).toContain("connect-src 'none'");
        expect(html).toContain("script-src 'nonce-");
        expect(html).toContain("style-src 'unsafe-inline'");
    });

    it('renders multiline textarea with keyboard instructions', () => {
        const html = getWebviewHtml(provider.getState());
        expect(html).toContain('Enter to submit • Shift+Enter for newline');
        expect(html).toContain('id="prompt-input"');
    });

    it('renders selected code preview when code is captured', () => {
        const state = provider.getState();
        state.selectedCode = NEUTRAL_CODE_SNIPPET;
        state.activeFile = 'calc.ts';
        state.languageId = 'typescript';

        const html = getWebviewHtml(state);
        expect(html).toContain('Selected: calc.ts (typescript)');
        expect(html).toContain('calculateTotal');
    });

    it('processes webview submit message and starts enforcement flow', async () => {
        client.setAllow();

        let receivedHtml = '';
        const mockWebviewView: any = {
            webview: {
                options: {},
                onDidReceiveMessage: vi.fn(),
                set html(val: string) {
                    receivedHtml = val;
                },
                get html() {
                    return receivedHtml;
                },
            },
        };

        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

        await provider.handleWebviewMessage({
            type: 'submit',
            prompt: NEUTRAL_PROMPT_1,
            serviceId: 'github_copilot',
        });

        const activeTicket = controller.getActiveTicket();
        expect(activeTicket).not.toBeNull();
        expect(activeTicket?.state).toBe('AUTHORIZED');
        expect(receivedHtml).toContain('Submission Allowed');
    });

    it('processes coachProceed message and updates view', async () => {
        client.setDlpCoach();

        const mockWebviewView: any = {
            webview: {
                options: {},
                onDidReceiveMessage: vi.fn(),
                html: '',
            },
        };
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

        await provider.handleWebviewMessage({
            type: 'submit',
            prompt: NEUTRAL_PROMPT_1,
            serviceId: 'github_copilot',
        });

        expect(controller.getActiveTicket()?.state).toBe('PENDING');

        // User proceeds
        await provider.handleWebviewMessage({
            type: 'coachProceed',
        });

        expect(controller.getActiveTicket()?.state).toBe('AUTHORIZED');
        expect(mockWebviewView.webview.html).toContain('Submission Authorized');
    });

    it('processes redactProceed message by writing sanitized text into state', async () => {
        const sanitized = 'sanitized prompt';
        client.setDlpRedact(sanitized);

        const mockWebviewView: any = {
            webview: {
                options: {},
                onDidReceiveMessage: vi.fn(),
                html: '',
            },
        };
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

        await provider.handleWebviewMessage({
            type: 'submit',
            prompt: NEUTRAL_PROMPT_1,
            serviceId: 'github_copilot',
        });

        expect(controller.getActiveTicket()?.state).toBe('PENDING');

        await provider.handleWebviewMessage({
            type: 'redactProceed',
        });

        expect(controller.getActiveTicket()?.state).toBe('AUTHORIZED');
        expect(provider.getState().promptText).toBe(sanitized);
    });
});
