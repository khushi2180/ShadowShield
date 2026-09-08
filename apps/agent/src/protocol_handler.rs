use log::{error, info};
use shadowshield_core::Inspector;
use shadowshield_protocol::ipc::{
    EvaluateAiAccessRequest, EvaluateAiAccessResponse, HealthResponse, HelloRequest, HelloResponse,
    InspectRequest, InspectResponse, IpcErrorPayload, IpcErrorResponse, IpcRequest, IpcResponse,
};
use shadowshield_protocol::{AiServiceId, InspectionRequest, InspectionSource, SensitiveText};
use std::io::{self};

use crate::native_messaging::{read_message, write_message, NativeMessagingError};

const PROTOCOL_VERSION: u32 = 1;
const AGENT_VERSION: &str = "0.1.0-dev";

pub fn run_host_mode() {
    let stdin = io::stdin();
    let stdout = io::stdout();

    // Disable all log outputs to stdout, redirect to stderr to protect framing
    // Note: env_logger init should be configured to stderr in main.rs

    let inspector = Inspector::new();

    loop {
        match read_message::<_, IpcRequest>(stdin.lock()) {
            Ok(Some(req)) => {
                let resp = handle_request(req, &inspector);
                if let Err(e) = write_message(stdout.lock(), &resp) {
                    error!("Failed to write native messaging response: {:?}", e);
                    break;
                }
            }
            Ok(None) => {
                info!("EOF received from browser, terminating host mode.");
                break;
            }
            Err(e) => {
                match e {
                    NativeMessagingError::MessageTooLarge(size) => {
                        error!("Received oversized message: {} bytes", size);
                        // Write error back
                        let _ = write_message(
                            stdout.lock(),
                            &IpcErrorResponse {
                                protocol_version: PROTOCOL_VERSION,
                                request_id: None,
                                msg_type: "Error".to_string(),
                                payload: IpcErrorPayload {
                                    code: "message_too_large".to_string(),
                                    message: format!("Message exceeded size limit: {}", size),
                                },
                            },
                        );
                    }
                    _ => {
                        error!("Native messaging read error: {:?}", e);
                        // Fatal error in framing, must exit to avoid sync issues
                        break;
                    }
                }
            }
        }
    }
}

fn handle_request(req: IpcRequest, inspector: &Inspector) -> IpcResponse {
    if req.protocol_version != PROTOCOL_VERSION {
        return build_error(
            req.request_id,
            "unsupported_protocol",
            &format!("Unsupported protocol version: {}", req.protocol_version),
        );
    }

    match req.msg_type.as_str() {
        "Hello" => {
            let hello: HelloRequest = match serde_json::from_value(req.payload) {
                Ok(v) => v,
                Err(_) => {
                    return build_error(
                        req.request_id,
                        "malformed_message",
                        "Invalid Hello payload",
                    )
                }
            };
            build_success(
                req.request_id,
                "HelloResponse",
                HelloResponse {
                    agent_version: AGENT_VERSION.to_string(),
                    protocol_version: PROTOCOL_VERSION,
                    compatible: hello.protocol_version == PROTOCOL_VERSION,
                },
            )
        }
        "Health" => build_success(
            req.request_id,
            "HealthResponse",
            HealthResponse {
                agent_running: true,
                inspection_engine_available: true,
                protocol_version: PROTOCOL_VERSION,
            },
        ),
        "EvaluateAiAccess" => {
            let eval_req: EvaluateAiAccessRequest = match serde_json::from_value(req.payload) {
                Ok(v) => v,
                Err(_) => {
                    return build_error(
                        req.request_id,
                        "malformed_message",
                        "Invalid EvaluateAiAccess payload",
                    )
                }
            };

            let service_id_parsed = match AiServiceId::new(&eval_req.service_id) {
                Ok(id) => id,
                Err(e) => {
                    return build_error(
                        req.request_id,
                        "invalid_request",
                        &format!("Invalid AiServiceId: {}", e),
                    )
                }
            };

            let assessment = inspector.evaluate_ai_access(&service_id_parsed, &eval_req.mode);

            build_success(
                req.request_id,
                "EvaluateAiAccessResponse",
                EvaluateAiAccessResponse {
                    service_id: assessment.service_id.as_str().to_string(),
                    classification: assessment.classification,
                    mode: assessment.mode,
                    decision: assessment.decision,
                    reason: assessment.reason,
                },
            )
        }
        "Inspect" => {
            let inspect_req: InspectRequest = match serde_json::from_value(req.payload) {
                Ok(v) => v,
                Err(_) => {
                    return build_error(
                        req.request_id,
                        "malformed_message",
                        "Invalid Inspect payload",
                    )
                }
            };

            // Process carefully without logging content
            let inspection_req = InspectionRequest {
                request_id: req.request_id.clone(),
                source: InspectionSource::BrowserExtension,
                ai_service: inspect_req.ai_service,
                content: SensitiveText::new(inspect_req.content),
                timestamp: inspect_req.timestamp,
            };

            match inspector.inspect(inspection_req) {
                Ok(result) => build_success(
                    req.request_id,
                    "InspectResponse",
                    InspectResponse {
                        detections_count: result.detections.len(),
                        detections: result.detections,
                        risk_assessment: result.risk_assessment,
                        action: result.action,
                        sanitized_content: result.sanitized_content.map(|s| s.expose().to_string()),
                        processing_duration_ms: result.processing_duration_ms,
                    },
                ),
                Err(e) => build_error(
                    req.request_id,
                    "internal_error",
                    &format!("Inspection failed: {:?}", e),
                ),
            }
        }
        unknown => build_error(
            req.request_id,
            "invalid_request",
            &format!("Unknown message type: {}", unknown),
        ),
    }
}

fn build_success<T: serde::Serialize>(
    request_id: String,
    msg_type: &str,
    payload: T,
) -> IpcResponse {
    IpcResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        msg_type: msg_type.to_string(),
        payload: serde_json::to_value(payload).unwrap(),
    }
}

fn build_error(request_id: String, code: &str, message: &str) -> IpcResponse {
    let err_resp = IpcErrorResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: Some(request_id.clone()),
        msg_type: "Error".to_string(),
        payload: IpcErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    IpcResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        msg_type: "Error".to_string(),
        payload: serde_json::to_value(err_resp.payload).unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shadowshield_protocol::{AiAccessDecision, PolicyAction, RiskLevel};

    fn make_request(msg_type: &str, payload: serde_json::Value) -> IpcRequest {
        IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "req-123".to_string(),
            msg_type: msg_type.to_string(),
            payload,
        }
    }

    #[test]
    fn test_hello_compatible() {
        let inspector = Inspector::new();
        let req = make_request(
            "Hello",
            serde_json::json!({
                "extension_version": "1.0",
                "protocol_version": PROTOCOL_VERSION
            }),
        );

        let resp = handle_request(req, &inspector);
        assert_eq!(resp.msg_type, "HelloResponse");
        let payload: HelloResponse = serde_json::from_value(resp.payload).unwrap();
        assert!(payload.compatible);
    }

    #[test]
    fn test_hello_incompatible() {
        let inspector = Inspector::new();
        let req = make_request(
            "Hello",
            serde_json::json!({
                "extension_version": "1.0",
                "protocol_version": 9999
            }),
        );

        let resp = handle_request(req, &inspector);
        assert_eq!(resp.msg_type, "HelloResponse");
        let payload: HelloResponse = serde_json::from_value(resp.payload).unwrap();
        assert!(!payload.compatible);
    }

    #[test]
    fn test_health() {
        let inspector = Inspector::new();
        let req = make_request("Health", serde_json::json!({}));
        let resp = handle_request(req, &inspector);
        assert_eq!(resp.msg_type, "HealthResponse");
        let payload: HealthResponse = serde_json::from_value(resp.payload).unwrap();
        assert!(payload.agent_running);
    }

    #[test]
    fn test_evaluate_ai_access() {
        let inspector = Inspector::new();
        // Since chatgpt is in default registry as Unknown
        let req = make_request(
            "EvaluateAiAccess",
            serde_json::json!({
                "service_id": "chatgpt",
                "mode": "Policy"
            }),
        );
        let resp = handle_request(req, &inspector);
        assert_eq!(resp.msg_type, "EvaluateAiAccessResponse");
        let payload: EvaluateAiAccessResponse = serde_json::from_value(resp.payload).unwrap();
        assert_eq!(payload.decision, AiAccessDecision::Coach); // Unknown -> Coach in Policy mode
    }

    #[test]
    fn test_inspect_clean_payload() {
        let inspector = Inspector::new();
        // Use purely neutral content, ensure it does NOT echo back
        let neutral_text = "just some standard non sensitive words";
        let req = make_request(
            "Inspect",
            serde_json::json!({
                "source": "BrowserExtension",
                "ai_service": "chatgpt",
                "content": neutral_text,
                "timestamp": 12345
            }),
        );

        let resp = handle_request(req, &inspector);
        assert_eq!(resp.msg_type, "InspectResponse");
        let payload: InspectResponse = serde_json::from_value(resp.payload).unwrap();

        assert_eq!(payload.detections_count, 0);
        assert_eq!(payload.risk_assessment.level, RiskLevel::Low);
        assert_eq!(payload.action, PolicyAction::Allow);
        assert!(payload.sanitized_content.is_none());
    }

    #[test]
    fn test_malformed_inspect_does_not_echo() {
        let inspector = Inspector::new();
        let neutral_text = "some text";
        // Malformed: Missing timestamp field
        let req = make_request(
            "Inspect",
            serde_json::json!({
                "source": "BrowserExtension",
                "ai_service": "chatgpt",
                "content": neutral_text
            }),
        );

        let resp = handle_request(req, &inspector);
        assert_eq!(resp.msg_type, "Error");
        let payload: IpcErrorPayload = serde_json::from_value(resp.payload).unwrap();
        assert_eq!(payload.code, "malformed_message");
        // Ensure error doesn't dump the parsed JSON containing the sensitive text
        assert!(!payload.message.contains(neutral_text));
    }
}
