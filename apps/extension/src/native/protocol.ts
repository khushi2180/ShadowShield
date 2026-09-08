// apps/extension/src/native/protocol.ts

export const PROTOCOL_VERSION = 1;

export interface IpcRequest {
  protocol_version: number;
  request_id: string;
  type: string;
  payload: any;
}

export interface IpcResponse {
  protocol_version: number;
  request_id: string;
  type: string;
  payload: any;
}

export interface IpcErrorResponse {
  protocol_version: number;
  request_id: string | null;
  type: "Error";
  payload: IpcErrorPayload;
}

export interface IpcErrorPayload {
  code: string;
  message: string;
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
  mode: "Discovery" | "Policy" | "StrictAllowlist";
}

export interface EvaluateAiAccessResponse {
  service_id: string;
  classification: "Approved" | "Restricted" | "Blocked" | "Unknown";
  mode: "Discovery" | "Policy" | "StrictAllowlist";
  decision: "Allow" | "AllowRestricted" | "Coach" | "Block";
  reason: "ApprovedService" | "RestrictedService" | "BlockedService" | "UnknownService";
}

export interface InspectRequest {
  source: string;
  ai_service: string;
  content: string;
  timestamp: number;
}

export interface InspectResponse {
  detections_count: number;
  detections: any[];
  risk_assessment: any;
  action: "Allow" | "Coach" | "Redact" | "Block";
  sanitized_content: string | null;
  processing_duration_ms: number;
}
