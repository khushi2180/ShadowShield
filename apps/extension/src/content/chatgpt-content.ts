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

// Discovery state tracking
let hasProtected = false;
let notFoundCycles = 0;

// After this many consecutive NOT_FOUND cycles on a supported host, show Degraded.
// At 3 seconds per cycle, 4 cycles = 12 seconds.
const DEGRADED_AFTER_CYCLES = 4;

console.log("ShadowShield: ChatGPT Adapter initialized.");

// Discover iteratively. The adapter's MutationObserver handles re-binding after
// SPA navigation once initial protection is established. This interval is only
// needed for the initial composer discovery.
const discoveryInterval = setInterval(() => {
    if (hasProtected) {
        // Already protected. The adapter's MutationObserver handles rebinding.
        // Stop polling to avoid unnecessary work.
        clearInterval(discoveryInterval);
        return;
    }

    if (!isDisconnected) {
        const result = adapter.discoverComposer();

        if (result === 'FOUND') {
            hasProtected = true;
            notFoundCycles = 0;
            adapter.setProtectionState('Protected');
            adapter.interceptSubmission(handleUserSubmit);
            // Clear any Degraded warning that was shown during discovery attempts
            ui.showState('None');
            clearInterval(discoveryInterval);
        } else if (result === 'DEGRADED') {
            // Explicit DEGRADED from adapter (ambiguous composers)
            notFoundCycles = 0;
            ui.showState('Degraded');
        } else {
            // NOT_FOUND: increment counter, show Degraded after threshold
            notFoundCycles++;
            if (notFoundCycles >= DEGRADED_AFTER_CYCLES) {
                ui.showState('Degraded');
                // Keep polling — ChatGPT SPA may still render the composer later.
                // But we must not claim Protected.
            }
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

                    // Verify write-back to prevent fail-open on write failure
                    const verifiedText = adapter.readComposerText();
                    if (verifiedText === inspectResp.sanitized_content) {
                        adapter.resumeSubmission(submission, true);
                        ui.showState("Redacted");
                    } else {
                        // Write-back failed, fail closed
                        adapter.stopSubmission(submission);
                        ui.showState("Degraded");
                    }
                } else {
                    // Action Redact but no sanitized_content provided — fail closed
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
