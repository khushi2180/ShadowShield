/**
 * Mock implementation of the 'vscode' module for unit tests.
 */

export const window = {
    activeTextEditor: undefined as any,
    registerWebviewViewProvider: (id: string, provider: any) => ({
        dispose: () => {},
    }),
    createOutputChannel: (name: string) => ({
        show: () => {},
        appendLine: () => {},
        dispose: () => {},
    }),
    showInformationMessage: (msg: string) => Promise.resolve(),
    showErrorMessage: (msg: string) => Promise.resolve(),
};

export const commands = {
    registerCommand: (cmd: string, handler: Function) => ({
        dispose: () => {},
    }),
    executeCommand: (cmd: string, ...args: any[]) => Promise.resolve(),
};

export const lm = {
    selectChatModels: () => Promise.resolve([]),
};

export class CancellationTokenSource {
    token = {};
    cancel() {}
    dispose() {}
}

export const LanguageModelChatMessage = {
    User: (content: string) => ({ role: 1, content }),
    Assistant: (content: string) => ({ role: 2, content }),
};

export const version = '1.90.0';
