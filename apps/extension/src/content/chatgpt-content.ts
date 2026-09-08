import { ChatGPTAdapter } from '../adapters/chatgpt';
import { EnforcementUi } from '../enforcement/ui';
import { ExtensionMessageEnvelope, InspectMessage, EvaluateAiAccessMessage } from '../native/messages';

const adapter = new ChatGPTAdapter();
const ui = new EnforcementUi();

let isDisconnected = false;

// We need a helper to send messages to the background script
async function sendMessageToBackground(payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const envelope: ExtensionMessageEnvelope = {
            shadowshield: true,
            request_id: `req_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            payload
        };

        chrome.runtime.sendMessage(envelope, (response) => {
            if (chrome.runtime.lastError) {
                isDisconnected = true;
                return reject(new Error(chrome.runtime.lastError.message));
            }
            if (!response || !response.success) {
                const err = response?.error || "Unknown error";
                if (err.includes("disconnected") || err.includes("connection")) {
                    isDisconnected = true;
                }
                return reject(new Error(err));
            }
            isDisconnected = false;
            resolve(response.response);
        });
    });
}

let hasProtected = false;

console.log("ShadowShield: ChatGPT Adapter initialized.");

// Discover iteratively
setInterval(() => {
    // If the adapter says DEGRADED, show it once persistently if not disconnected
    if (!isDisconnected) {
        const result = adapter.discoverComposer();
        console.log("chatgpt-content setInterval result:", result, "hasProtected:", hasProtected);
        if (result === 'FOUND' && !hasProtected) {
            hasProtected = true;
            console.log("chatgpt-content intercepting submission...");
            adapter.interceptSubmission(handleUserSubmit);
        } else if (result === 'DEGRADED') {
            ui.showState('Degraded');
        }
    }
}, 3000);

const handleUserSubmit = async (text: string, submission: any) => {
    const runDlpInspection = async () => {
        // 2. DLP Inspection Flow
        const inspectReq: InspectMessage = {
            type: "Inspect",
            source: "browser_extension",
            ai_service: adapter.serviceId(),
            content: text,
            timestamp: Date.now()
        };

        const inspectResp = await sendMessageToBackground(inspectReq);

        switch (inspectResp.action) {
            case "Allow":
                adapter.resumeSubmission(submission);
                break;
            case "Block":
                adapter.stopSubmission(submission);
                ui.showState("Blocked");
                break;
            case "Coach":
                ui.showState("Coach", {
                    onCancel: () => adapter.stopSubmission(submission),
                    onProceed: () => adapter.resumeSubmission(submission)
                });
                break;
            case "Redact":
                if (inspectResp.sanitized_content) {
                    adapter.writeComposerText(inspectResp.sanitized_content);
                    
                    // We must verify the written content to prevent FAIL OPEN
                    const verifiedText = adapter.readComposerText();
                    if (verifiedText === inspectResp.sanitized_content) {
                        adapter.resumeSubmission(submission, true);
                        ui.showState("Redacted");
                    } else {
                        // Write-back failed, fail closed!
                        adapter.stopSubmission(submission);
                        ui.showState("Degraded");
                    }
                } else {
                    // Action Redact but no sanitized_content provided! Fail closed.
                    adapter.stopSubmission(submission);
                    ui.showState("Blocked");
                }
                break;
            default:
                adapter.stopSubmission(submission);
                ui.showState("Blocked");
                break;
        }
    }; // end of runDlpInspection

    try {
        // 1. AI Access Check
        const accessReq: EvaluateAiAccessMessage = {
            type: "EvaluateAiAccess",
            service_id: adapter.serviceId(),
            mode: "Policy"
        };
        
        const accessResp = await sendMessageToBackground(accessReq);
        
        if (accessResp.decision === "Block") {
            adapter.stopSubmission(submission);
            ui.showState("Blocked");
            return;
        }

        if (accessResp.decision === "Coach") {
            ui.showState("Coach", {
                onCancel: () => adapter.stopSubmission(submission),
                onProceed: () => runDlpInspection()
            });
            return;
        }

        await runDlpInspection();
    } catch (e: any) {
        console.warn("ShadowShield Request failed:", e.message);
        adapter.stopSubmission(submission);
        if (isDisconnected || e.message.includes("disconnected") || e.message.includes("establish connection")) {
            ui.showState("Disconnected");
        } else {
            ui.showState("Blocked"); // Fail closed safely
        }
    }
};

export const _testAdapter = adapter;
