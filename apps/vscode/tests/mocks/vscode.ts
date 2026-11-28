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
    selectChatModels: (options?: { vendor?: string }) => {
        if (options?.vendor && options.vendor !== 'copilot') {
            return Promise.resolve([]);
        }
        return Promise.resolve([
            {
                id: 'copilot-gpt-4o',
                name: 'GitHub Copilot GPT-4o',
                vendor: 'copilot',
                family: 'gpt-4o',
                maxInputTokens: 128000,
                sendRequest: async (_messages: any[]) => ({
                    text: (async function* () {
                        yield 'Mock response from copilot';
                    })(),
                }),
            },
        ]);
    },
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
