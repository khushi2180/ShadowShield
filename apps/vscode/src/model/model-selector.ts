import * as vscode from 'vscode';

export interface VerifiedModelTarget {
    model: any; // vscode.LanguageModelChat
    serviceId: 'github_copilot';
    modelId: string;
    vendor: string;
    family: string;
}

/**
 * Resolves and verifies an active LanguageModelChat from vscode.lm
 * strictly according to docs/v2/IPC_CONTRACT.md §7.1.
 *
 * Rules:
 * 1. Requires vscode.lm API to be present (VS Code >= 1.90.0).
 * 2. Queries available chat models from vscode.lm.selectChatModels({ vendor: 'copilot' }).
 * 3. Strictly verifies that vendor is 'copilot'.
 * 4. Maps vendor 'copilot' strictly to AiServiceId 'github_copilot'.
 * 5. Unknown, unapproved, or unverifiable model/vendor identities FAIL CLOSED.
 */
export class ModelSelector {
    public static async resolveApprovedModel(
        vscodeRef: any = vscode,
        preferredModelId?: string
    ): Promise<VerifiedModelTarget> {
        if (!vscodeRef?.lm) {
            throw new Error(
                'vscode.lm API is unavailable in this environment (requires VS Code >= 1.90.0)'
            );
        }

        let models: any[];
        try {
            models = await vscodeRef.lm.selectChatModels({ vendor: 'copilot' });
        } catch (err: any) {
            throw new Error(`Failed to query vscode.lm models: ${err?.message || err}`);
        }

        if (!models || models.length === 0) {
            // Check all models to provide a precise diagnostic if an unapproved vendor exists
            let allModels: any[] = [];
            try {
                allModels = await vscodeRef.lm.selectChatModels();
            } catch (_) {}

            if (allModels && allModels.length > 0) {
                const unapprovedVendors = allModels.map((m: any) => m.vendor || 'unknown').join(', ');
                throw new Error(
                    `Unapproved model vendor detected (${unapprovedVendors}). Only vendor "copilot" (mapped to github_copilot) is approved by security policy.`
                );
            }

            throw new Error(
                'No language models available. Ensure GitHub Copilot is installed and authenticated.'
            );
        }

        let selected: any;
        if (preferredModelId) {
            selected = models.find((m: any) => m.id === preferredModelId);
            if (!selected) {
                throw new Error(
                    `Intended model ID "${preferredModelId}" was not found among available Copilot models.`
                );
            }
        } else if (models.length === 1) {
            // Exactly one model registered under vendor 'copilot'
            selected = models[0];
        } else {
            // Multiple Copilot models available, but no explicit intended model ID was established.
            // Fail closed rather than arbitrarily choosing models[0].
            const modelList = models
                .map((m: any) => `"${m.id}" (${m.name || m.family || 'copilot'})`)
                .join(', ');
            throw new Error(
                `Ambiguous model selection: Multiple Copilot models available [${modelList}]. An explicit model ID must be selected to bind authorization to an exact model.`
            );
        }

        // Strict verification: vendor must be 'copilot'
        if (!selected || selected.vendor !== 'copilot') {
            const actualVendor = selected?.vendor || 'unknown';
            throw new Error(
                `Security violation: Model ${selected?.id || 'unknown'} has unapproved vendor "${actualVendor}". Expected "copilot".`
            );
        }

        return {
            model: selected,
            serviceId: 'github_copilot',
            modelId: selected.id || 'unknown',
            vendor: selected.vendor,
            family: selected.family || 'unknown',
        };
    }
}
