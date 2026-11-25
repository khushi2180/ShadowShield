import { IIpcClient } from './client-interface';
import {
    AuthenticateResponse,
    HelloResponse,
    HealthResponse,
    EvaluateAiAccessRequest,
    EvaluateAiAccessResponse,
    InspectRequest,
    InspectResponse,
    AiAccessMode,
    PROTOCOL_VERSION,
} from './protocol';

/**
 * Deterministic Mock IPC Client for V1 Scaffold and Unit Testing.
 * Simulates all contract states without a live Rust agent process.
 */
export class MockIpcClient implements IIpcClient {
    private connected = true;
    private artificialDelayMs = 0;

    private evaluateAiAccessHandler?: (req: EvaluateAiAccessRequest) => Promise<EvaluateAiAccessResponse>;
    private inspectHandler?: (req: InspectRequest) => Promise<InspectResponse>;

    public setConnected(connected: boolean): void {
        this.connected = connected;
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public setArtificialDelay(ms: number): void {
        this.artificialDelayMs = ms;
    }

    public setEvaluateAiAccessHandler(
        handler: (req: EvaluateAiAccessRequest) => Promise<EvaluateAiAccessResponse>
    ): void {
        this.evaluateAiAccessHandler = handler;
    }

    public setInspectHandler(
        handler: (req: InspectRequest) => Promise<InspectResponse>
    ): void {
        this.inspectHandler = handler;
    }

    // --- Canned State Helpers ---

    public setAllow(): void {
        this.evaluateAiAccessHandler = async (req) => ({
            service_id: req.service_id,
            classification: 'Approved',
            mode: req.mode,
            decision: 'Allow',
            reason: 'ApprovedService',
        });
        this.inspectHandler = async () => ({
            detections_count: 0,
            detections: [],
            risk_assessment: {
                score: 0,
                level: 'Low',
                primary_detection_index: null,
            },
            action: 'Allow',
            sanitized_content: null,
            processing_duration_ms: 1,
        });
    }

    public setAiAccessCoach(): void {
        this.evaluateAiAccessHandler = async (req) => ({
            service_id: req.service_id,
            classification: 'Unknown',
            mode: req.mode,
            decision: 'Coach',
            reason: 'UnknownService',
        });
    }

    public setAiAccessBlock(): void {
        this.evaluateAiAccessHandler = async (req) => ({
            service_id: req.service_id,
            classification: 'Blocked',
            mode: req.mode,
            decision: 'Block',
            reason: 'BlockedService',
        });
    }

    public setDlpCoach(): void {
        this.evaluateAiAccessHandler = async (req) => ({
            service_id: req.service_id,
            classification: 'Approved',
            mode: req.mode,
            decision: 'Allow',
            reason: 'ApprovedService',
        });
        this.inspectHandler = async () => ({
            detections_count: 1,
            detections: [],
            risk_assessment: {
                score: 40,
                level: 'Medium',
                primary_detection_index: 0,
            },
            action: 'Coach',
            sanitized_content: null,
            processing_duration_ms: 2,
        });
    }

    public setDlpRedact(sanitizedText: string): void {
        this.evaluateAiAccessHandler = async (req) => ({
            service_id: req.service_id,
            classification: 'Approved',
            mode: req.mode,
            decision: 'Allow',
            reason: 'ApprovedService',
        });
        this.inspectHandler = async () => ({
            detections_count: 1,
            detections: [],
            risk_assessment: {
                score: 75,
                level: 'High',
                primary_detection_index: 0,
            },
            action: 'Redact',
            sanitized_content: sanitizedText,
            processing_duration_ms: 3,
        });
    }

    public setDlpBlock(): void {
        this.evaluateAiAccessHandler = async (req) => ({
            service_id: req.service_id,
            classification: 'Approved',
            mode: req.mode,
            decision: 'Allow',
            reason: 'ApprovedService',
        });
        this.inspectHandler = async () => ({
            detections_count: 2,
            detections: [],
            risk_assessment: {
                score: 95,
                level: 'Critical',
                primary_detection_index: 0,
            },
            action: 'Block',
            sanitized_content: null,
            processing_duration_ms: 2,
        });
    }

    private async maybeDelay(): Promise<void> {
        if (this.artificialDelayMs > 0) {
            await new Promise((res) => setTimeout(res, this.artificialDelayMs));
        }
    }

    public async authenticate(token: string): Promise<AuthenticateResponse> {
        if (!this.connected) throw new Error('Not connected to agent');
        await this.maybeDelay();
        if (!token || token.length !== 64) {
            throw new Error('Invalid authentication token');
        }
        return { authenticated: true };
    }

    public async hello(extensionVersion: string): Promise<HelloResponse> {
        if (!this.connected) throw new Error('Not connected to agent');
        await this.maybeDelay();
        return {
            agent_version: '0.1.0-dev',
            protocol_version: PROTOCOL_VERSION,
            compatible: true,
        };
    }

    public async health(): Promise<HealthResponse> {
        if (!this.connected) throw new Error('Not connected to agent');
        await this.maybeDelay();
        return {
            agent_running: true,
            inspection_engine_available: true,
            protocol_version: PROTOCOL_VERSION,
        };
    }

    public async evaluateAiAccess(
        serviceId: string,
        mode: AiAccessMode
    ): Promise<EvaluateAiAccessResponse> {
        if (!this.connected) throw new Error('Not connected to agent');
        await this.maybeDelay();

        if (this.evaluateAiAccessHandler) {
            return this.evaluateAiAccessHandler({ service_id: serviceId, mode });
        }

        // Default behavior according to IPC contract: github_copilot in Policy mode defaults to Coach
        if (serviceId === 'github_copilot' && mode === 'Policy') {
            return {
                service_id: 'github_copilot',
                classification: 'Unknown',
                mode: 'Policy',
                decision: 'Coach',
                reason: 'UnknownService',
            };
        }

        return {
            service_id: serviceId,
            classification: 'Approved',
            mode,
            decision: 'Allow',
            reason: 'ApprovedService',
        };
    }

    public async inspect(request: InspectRequest): Promise<InspectResponse> {
        if (!this.connected) throw new Error('Not connected to agent');
        await this.maybeDelay();

        if (this.inspectHandler) {
            return this.inspectHandler(request);
        }

        return {
            detections_count: 0,
            detections: [],
            risk_assessment: {
                score: 0,
                level: 'Low',
                primary_detection_index: null,
            },
            action: 'Allow',
            sanitized_content: null,
            processing_duration_ms: 1,
        };
    }

    public disconnect(): void {
        this.connected = false;
    }
}
