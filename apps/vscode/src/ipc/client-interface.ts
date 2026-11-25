import {
    AuthenticateResponse,
    HelloResponse,
    HealthResponse,
    EvaluateAiAccessResponse,
    InspectRequest,
    InspectResponse,
    AiAccessMode,
} from './protocol';

/**
 * Standard interface for communication with the ShadowShield security agent.
 * Implemented by MockIpcClient in V1 / Phase 1, and real Unix Domain Socket IPC in V2 / Phase 2 (after R1/R2 approval).
 */
export interface IIpcClient {
    isConnected(): boolean;
    authenticate(token: string): Promise<AuthenticateResponse>;
    hello(extensionVersion: string): Promise<HelloResponse>;
    health(): Promise<HealthResponse>;
    evaluateAiAccess(serviceId: string, mode: AiAccessMode): Promise<EvaluateAiAccessResponse>;
    inspect(request: InspectRequest): Promise<InspectResponse>;
    disconnect(): void;
}
