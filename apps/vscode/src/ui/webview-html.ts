import * as crypto from 'crypto';
import { BannerState, WebviewState } from '../controller/types';

/**
 * Generates secure, CSP-compliant HTML for the ShadowShield prompt composer webview.
 */
export function getWebviewHtml(state: WebviewState): string {
    const nonce = crypto.randomBytes(16).toString('base64');

    const escapeHtml = (str: string): string =>
        str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

    const selectionHtml = state.selectedCode
        ? `
        <div class="selection-card">
            <div class="selection-header">
                <span class="selection-title">
                    <svg class="icon" viewBox="0 0 16 16"><path fill="currentColor" d="M4.708 3.5a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-1 0V4a.5.5 0 0 1 .5-.5zm6.584 0a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-1 0V4a.5.5 0 0 1 .5-.5zM8 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 4z"/></svg>
                    Selected: ${escapeHtml(state.activeFile || 'Editor Code')} (${escapeHtml(state.languageId || 'text')})
                </span>
                <button type="button" class="btn-sm" id="btn-clear-selection">Remove</button>
            </div>
            <pre class="selection-preview">${escapeHtml(state.selectedCode)}</pre>
        </div>`
        : `
        <div class="selection-placeholder">
            <button type="button" class="btn-secondary btn-sm" id="btn-capture-selection">
                <svg class="icon" viewBox="0 0 16 16"><path fill="currentColor" d="M14 1H2a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zM2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2z"/></svg>
                Include Active Editor Selection
            </button>
        </div>`;

    const renderBanner = (banner: BannerState): string => {
        if (banner.type === 'None') return '';

        let themeClass = '';
        let buttonsHtml = '';

        switch (banner.type) {
            case 'Allow':
                themeClass = 'banner-allow';
                break;
            case 'Coach':
                themeClass = 'banner-coach';
                buttonsHtml = `
                    <div class="banner-actions">
                        <button type="button" class="btn-banner" id="btn-coach-cancel">Cancel</button>
                        <button type="button" class="btn-banner btn-primary" id="btn-coach-proceed">Proceed</button>
                    </div>`;
                break;
            case 'Redact':
                themeClass = 'banner-redact';
                buttonsHtml = `
                    <div class="banner-actions">
                        <button type="button" class="btn-banner" id="btn-redact-cancel">Cancel</button>
                        <button type="button" class="btn-banner btn-primary" id="btn-redact-proceed">Proceed with Redaction</button>
                    </div>`;
                break;
            case 'Block':
                themeClass = 'banner-block';
                buttonsHtml = `
                    <div class="banner-actions">
                        <button type="button" class="btn-banner" id="btn-block-dismiss">Dismiss</button>
                    </div>`;
                break;
            case 'Disconnected':
                themeClass = 'banner-disconnected';
                break;
        }

        return `
        <div class="shield-banner ${themeClass}" role="alert">
            <div class="banner-header">
                <svg class="shield-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span class="banner-title">${escapeHtml(banner.title)}</span>
            </div>
            <div class="banner-message">${escapeHtml(banner.message)}</div>
            ${
                banner.type === 'Redact'
                    ? `<div class="redact-preview"><strong>Sanitized Preview:</strong><pre>${escapeHtml(banner.sanitizedContent)}</pre></div>`
                    : ''
            }
            ${buttonsHtml}
        </div>`;
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'none';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ShadowShield Prompt Composer</title>
    <style>
        :root {
            --bg-color: var(--vscode-sideBar-background, #1e1e1e);
            --fg-color: var(--vscode-sideBar-foreground, #cccccc);
            --input-bg: var(--vscode-input-background, #252526);
            --input-fg: var(--vscode-input-foreground, #cccccc);
            --input-border: var(--vscode-input-border, #3c3c3c);
            --btn-bg: var(--vscode-button-background, #0e639c);
            --btn-fg: var(--vscode-button-foreground, #ffffff);
            --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
            --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
            --btn-sec-fg: var(--vscode-button-secondaryForeground, #ffffff);
            --card-bg: var(--vscode-editor-background, #1e1e1e);
            --border-color: var(--vscode-panel-border, #2d2d2d);
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--fg-color);
            margin: 0;
            padding: 12px;
            font-size: 13px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border-color);
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 13px;
        }

        .shield-icon {
            width: 16px;
            height: 16px;
            fill: #3b82f6;
        }

        .service-select {
            background-color: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
        }

        .selection-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 8px;
            font-size: 12px;
        }

        .selection-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 4px;
        }

        .selection-title {
            display: flex;
            align-items: center;
            gap: 4px;
            font-weight: 500;
            color: #93c5fd;
        }

        .selection-preview {
            margin: 4px 0 0 0;
            padding: 6px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 3px;
            max-height: 80px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 11px;
            white-space: pre-wrap;
            word-break: break-all;
        }

        .selection-placeholder {
            display: flex;
            justify-content: flex-start;
        }

        .composer-box {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .label-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: #888888;
        }

        textarea {
            width: 100%;
            height: 120px;
            min-height: 80px;
            resize: vertical;
            background-color: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            padding: 8px;
            font-family: inherit;
            font-size: 13px;
            line-height: 1.4;
            box-sizing: border-box;
            outline: none;
        }

        textarea:focus {
            border-color: #3b82f6;
        }

        .controls {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        button {
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            padding: 6px 14px;
            border: none;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .btn-primary {
            background-color: var(--btn-bg);
            color: var(--btn-fg);
        }

        .btn-primary:hover:not(:disabled) {
            background-color: var(--btn-hover);
        }

        .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .btn-secondary {
            background-color: var(--btn-sec-bg);
            color: var(--btn-sec-fg);
        }

        .btn-sm {
            padding: 3px 8px;
            font-size: 11px;
        }

        .icon {
            width: 14px;
            height: 14px;
        }

        /* Banners */
        .shield-banner {
            border-radius: 6px;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            border: 1px solid #374151;
            background: #1e1e1e;
        }

        .banner-header {
            display: flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            font-size: 13px;
        }

        .banner-message {
            font-size: 12px;
            line-height: 1.4;
            color: #d1d5db;
        }

        .banner-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 4px;
        }

        .btn-banner {
            background: #374151;
            color: #f9fafb;
            padding: 4px 10px;
            border-radius: 3px;
            font-size: 11px;
        }

        .btn-banner:hover {
            background: #4b5563;
        }

        .banner-allow {
            border-left: 4px solid #10b981;
        }
        .banner-allow .banner-title { color: #10b981; }

        .banner-coach {
            border-left: 4px solid #f59e0b;
        }
        .banner-coach .banner-title { color: #f59e0b; }

        .banner-redact {
            border-left: 4px solid #10b981;
        }
        .banner-redact .banner-title { color: #10b981; }

        .redact-preview {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid #374151;
            border-radius: 4px;
            padding: 6px;
            font-size: 11px;
            margin-top: 4px;
        }
        .redact-preview pre {
            margin: 4px 0 0 0;
            font-family: monospace;
            white-space: pre-wrap;
            word-break: break-all;
        }

        .banner-block {
            border-left: 4px solid #ef4444;
        }
        .banner-block .banner-title { color: #ef4444; }

        .banner-disconnected {
            border-left: 4px solid #9ca3af;
        }
        .banner-disconnected .banner-title { color: #9ca3af; }
    </style>
</head>
<body>
    <div class="header">
        <div class="brand">
            <svg class="shield-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span>ShadowShield</span>
        </div>
        <select id="service-select" class="service-select">
            <option value="github_copilot" ${state.selectedService === 'github_copilot' ? 'selected' : ''}>GitHub Copilot</option>
            <option value="chatgpt" ${state.selectedService === 'chatgpt' ? 'selected' : ''}>ChatGPT</option>
            <option value="claude" ${state.selectedService === 'claude' ? 'selected' : ''}>Claude</option>
            <option value="gemini" ${state.selectedService === 'gemini' ? 'selected' : ''}>Gemini</option>
        </select>
    </div>

    ${selectionHtml}

    <div class="composer-box">
        <div class="label-row">
            <span>Prompt</span>
            <span>Enter to submit • Shift+Enter for newline</span>
        </div>
        <textarea id="prompt-input" placeholder="Enter prompt to inspect and protect..." ${state.isInspecting ? 'disabled' : ''}>${escapeHtml(state.promptText)}</textarea>
    </div>

    <div class="controls">
        <button type="button" class="btn-secondary" id="btn-clear-all" ${state.isInspecting ? 'disabled' : ''}>Clear</button>
        <button type="button" class="btn-primary" id="btn-submit" ${state.isInspecting ? 'disabled' : ''}>
            ${state.isInspecting ? 'Inspecting...' : 'Inspect & Submit'}
        </button>
    </div>

    <div id="banner-region">
        ${renderBanner(state.banner)}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const promptInput = document.getElementById('prompt-input');
        const submitBtn = document.getElementById('btn-submit');
        const serviceSelect = document.getElementById('service-select');
        const clearBtn = document.getElementById('btn-clear-all');
        const captureBtn = document.getElementById('btn-capture-selection');
        const clearSelectionBtn = document.getElementById('btn-clear-selection');

        const btnCoachCancel = document.getElementById('btn-coach-cancel');
        const btnCoachProceed = document.getElementById('btn-coach-proceed');
        const btnRedactCancel = document.getElementById('btn-redact-cancel');
        const btnRedactProceed = document.getElementById('btn-redact-proceed');
        const btnBlockDismiss = document.getElementById('btn-block-dismiss');

        function doSubmit() {
            const prompt = promptInput.value.trim();
            if (!prompt) return;
            const serviceId = serviceSelect.value;
            vscode.postMessage({
                type: 'submit',
                prompt: promptInput.value,
                serviceId
            });
        }

        if (promptInput) {
            promptInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    doSubmit();
                }
            });
        }

        if (submitBtn) {
            submitBtn.addEventListener('click', () => {
                doSubmit();
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                promptInput.value = '';
                vscode.postMessage({ type: 'clearPrompt' });
            });
        }

        if (captureBtn) {
            captureBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'captureSelection' });
            });
        }

        if (clearSelectionBtn) {
            clearSelectionBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'clearSelection' });
            });
        }

        if (btnCoachCancel) {
            btnCoachCancel.addEventListener('click', () => {
                vscode.postMessage({ type: 'coachCancel' });
            });
        }

        if (btnCoachProceed) {
            btnCoachProceed.addEventListener('click', () => {
                vscode.postMessage({ type: 'coachProceed' });
            });
        }

        if (btnRedactCancel) {
            btnRedactCancel.addEventListener('click', () => {
                vscode.postMessage({ type: 'redactCancel' });
            });
        }

        if (btnRedactProceed) {
            btnRedactProceed.addEventListener('click', () => {
                vscode.postMessage({ type: 'redactProceed' });
            });
        }

        if (btnBlockDismiss) {
            btnBlockDismiss.addEventListener('click', () => {
                vscode.postMessage({ type: 'clearBanner' });
            });
        }
    </script>
</body>
</html>`;
}
