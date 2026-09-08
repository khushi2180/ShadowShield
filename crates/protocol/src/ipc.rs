use crate::{
    AiAccessDecision, AiAccessMode, AiAccessReason, AiServiceClassification, Detection,
    PolicyAction, RiskAssessment,
};
use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IpcRequest {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IpcResponse {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IpcErrorResponse {
    pub protocol_version: u32,
    pub request_id: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: String, // typically "Error"
    pub payload: IpcErrorPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IpcErrorPayload {
    pub code: String,
    pub message: String,
}

// -----------------------------------------------------------------------------
// Hello
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelloRequest {
    pub extension_version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelloResponse {
    pub agent_version: String,
    pub protocol_version: u32,
    pub compatible: bool,
}

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthRequest {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub agent_running: bool,
    pub inspection_engine_available: bool,
    pub protocol_version: u32,
}

// -----------------------------------------------------------------------------
// EvaluateAiAccess
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvaluateAiAccessRequest {
    pub service_id: String, // String here, will be parsed to AiServiceId
    pub mode: AiAccessMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvaluateAiAccessResponse {
    pub service_id: String,
    pub classification: AiServiceClassification,
    pub mode: AiAccessMode,
    pub decision: AiAccessDecision,
    pub reason: AiAccessReason,
}

// -----------------------------------------------------------------------------
// Inspect
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InspectRequest {
    pub source: String,
    pub ai_service: String,
    // Custom deserializer to ensure we parse to SensitiveText,
    // but for the IPC struct we can take String and construct SensitiveText downstream.
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InspectResponse {
    pub detections_count: usize,
    pub detections: Vec<Detection>,
    pub risk_assessment: RiskAssessment,
    pub action: PolicyAction,
    // Store as plain string in IPC, convert from SanitizedText downstream
    pub sanitized_content: Option<String>,
    pub processing_duration_ms: u64,
}
