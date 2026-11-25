/**
 * TypeScript protocol types matching crates/protocol/src/ipc.rs,
 * crates/protocol/src/lib.rs, and docs/v2/IPC_CONTRACT.md.
 */

export const PROTOCOL_VERSION = 1;

export type AiAccessMode = 'Discovery' | 'Policy' | 'StrictAllowlist';
export type AiServiceClassification = 'Approved' | 'Restricted' | 'Blocked' | 'Unknown';
export type AiAccessDecision = 'Allow' | 'AllowRestricted' | 'Coach' | 'Block';
export type AiAccessReason = 'ApprovedService' | 'RestrictedService' | 'BlockedService' | 'UnknownService';

export type PolicyAction = 'Allow' | 'Coach' | 'Redact' | 'Block';
export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';
export type Severity = 'Low' | 'Medium' | 'High' | 'Critical';
export type ValidationLevel = 'PatternMatch' | 'StructurallyValid' | 'ChecksumValid' | 'ContextCorrelated';
export type DetectionCategory = 'Secret' | 'Credential' | 'Pii' | 'SourceCode' | 'TestStructural';

export interface DetectionLocation {
    start_byte: number;
    end_byte: number;
}

export interface Detection {
    category: DetectionCategory;
    kind: string;
    detector_id: string;
    confidence: number;
    validation: ValidationLevel;
    location: DetectionLocation | null;
    severity: Severity;
}

export interface RiskAssessment {
    score: number;
    level: RiskLevel;
    primary_detection_index: number | null;
}

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

export interface IpcRequest<T = any> {
    protocol_version: number;
    request_id: string;
    type: string;
    payload: T;
}

export interface IpcResponse<T = any> {
    protocol_version: number;
    request_id: string;
    type: string;
    payload: T;
}

export interface IpcErrorPayload {
    code: string;
    message: string;
}

export interface IpcErrorResponse {
    protocol_version: number;
    request_id: string | null;
    type: 'Error';
    payload: IpcErrorPayload;
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

export interface AuthenticateRequest {
    token: string;
}

export interface AuthenticateResponse {
    authenticated: boolean;
}

export interface HelloRequest {
    extension_version: string;
    protocol_version: number;
}

export interface HelloResponse {
    agent_version: string;
    protocol_version: number;
    compatible: boolean;
}

export interface HealthRequest {}

export interface HealthResponse {
    agent_running: boolean;
    inspection_engine_available: boolean;
    protocol_version: number;
}

export interface EvaluateAiAccessRequest {
    service_id: string;
    mode: AiAccessMode;
}

export interface EvaluateAiAccessResponse {
    service_id: string;
    classification: AiServiceClassification;
    mode: AiAccessMode;
    decision: AiAccessDecision;
    reason: AiAccessReason;
}

export interface InspectRequest {
    source: string;
    ai_service: string;
    content: string;
    timestamp: number;
}

export interface InspectResponse {
    detections_count: number;
    detections: Detection[];
    risk_assessment: RiskAssessment;
    action: PolicyAction;
    sanitized_content: string | null;
    processing_duration_ms: number;
}
