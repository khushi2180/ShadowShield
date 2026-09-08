export type ProtectionState = "Initializing" | "Protected" | "Degraded" | "Disconnected";

export interface InterceptedSubmission {
    id: string;
    contentVersion: string; // Hash of the content to prevent stale operations
    trigger: string;        // "keyboard" | "button"
    state: "PAUSED" | "RESUMED" | "STOPPED";
}

export interface AiSiteAdapter {
    serviceId(): string;
    matchesCurrentPage(): boolean;
    discoverComposer(): "FOUND" | "NOT_FOUND" | "DEGRADED";
    readComposerText(): string;
    writeComposerText(text: string): void;
    interceptSubmission(onUserSubmit: (text: string, submission: InterceptedSubmission) => void): void;
    resumeSubmission(submission: InterceptedSubmission): void;
    stopSubmission(submission: InterceptedSubmission): void;
    setProtectionState(state: ProtectionState): void;
    dispose(): void;
}
