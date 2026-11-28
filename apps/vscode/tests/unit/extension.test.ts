import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate, _getInternalState } from '../../src/extension';
import { MockIpcClient } from '../../src/ipc/mock-client';
import { RealIpcClient } from '../../src/ipc/real-client';

vi.mock('vscode', () => {
    const subscriptions: any[] = [];
    const commandsMap = new Map<string, (...args: any[]) => any>();

    return {
        window: {
            registerWebviewViewProvider: vi.fn((id, provider) => {
                return { dispose: vi.fn() };
            }),
            createOutputChannel: vi.fn(() => ({
                show: vi.fn(),
                appendLine: vi.fn(),
                dispose: vi.fn(),
            })),
            showInformationMessage: vi.fn(),
            showErrorMessage: vi.fn(),
        },
        commands: {
            registerCommand: vi.fn((cmd, handler) => {
                commandsMap.set(cmd, handler);
                return { dispose: vi.fn() };
            }),
            executeCommand: vi.fn(async (cmd, ...args) => {
                const handler = commandsMap.get(cmd);
                if (handler) return handler(...args);
            }),
            _getCommands: () => commandsMap,
        },
    };
});

describe('VS Code Extension Activation', () => {
    let mockContext: vscode.ExtensionContext;

    beforeEach(() => {
        mockContext = {
            subscriptions: [],
        } as any;
    });

    it('activates successfully with mock client and registers webview provider and commands', () => {
        const mockClient = new MockIpcClient();
        mockClient.setAllow();
        activate(mockContext, { ipcClient: mockClient });

        // 1. Registered webview provider
        expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
            'shadowshield.promptView',
            expect.anything()
        );

        // 2. Registered commands
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'shadowshield.openComposer',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'shadowshield.includeSelection',
            expect.any(Function)
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'shadowshield.probeLmCapability',
            expect.any(Function)
        );

        // 3. Extension context holds disposables
        expect(mockContext.subscriptions.length).toBeGreaterThanOrEqual(4);

        // 4. Internal state is initialized with mock client
        const state = _getInternalState();
        expect(state.mockClient).toBeDefined();
        expect(state.mockClient!.isConnected()).toBe(true);
        expect(state.controller).toBeDefined();
        expect(state.promptProvider).toBeDefined();
    });

    it('activates with production RealIpcClient by default (never falls back to mock)', () => {
        activate(mockContext);

        const state = _getInternalState();
        expect(state.client).toBeInstanceOf(RealIpcClient);
        expect(state.mockClient).toBeUndefined();
    });

    it('deactivates cleanly and disconnects active IPC client', () => {
        const mockClient = new MockIpcClient();
        mockClient.setAllow();
        activate(mockContext, { ipcClient: mockClient });
        deactivate();

        const state = _getInternalState();
        expect(state.mockClient!.isConnected()).toBe(false);
    });
});
