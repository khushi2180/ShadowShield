use log::{error, info, warn};
use shadowshield_core::{Inspector, InspectorError};
use shadowshield_protocol::ipc::{
    EvaluateAiAccessRequest, EvaluateAiAccessResponse, HealthResponse, HelloRequest, HelloResponse,
    InspectRequest, InspectResponse, IpcErrorPayload, IpcErrorResponse, IpcRequest, IpcResponse,
};
use shadowshield_protocol::{AiServiceId, InspectionRequest, InspectionSource, SensitiveText};
use std::fs;
use std::io;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::auth::{self, constant_time_eq, verify_peer_credentials};
use super::framing::{read_message, write_message, FramingError};
use super::transport::{
    default_runtime_dir, recover_stale_socket_and_bind, setup_runtime_dir, SingleInstanceLock,
};

const PROTOCOL_VERSION: u32 = 1;
const AGENT_VERSION: &str = "0.1.0-dev";
pub const DEFAULT_MAX_CLIENTS: usize = 16;
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct IpcServerConfig {
    pub runtime_dir: PathBuf,
    pub max_clients: usize,
    pub handshake_timeout: Duration,
    pub idle_timeout: Duration,
}

impl Default for IpcServerConfig {
    fn default() -> Self {
        Self {
            runtime_dir: default_runtime_dir(),
            max_clients: DEFAULT_MAX_CLIENTS,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        }
    }
}

#[derive(serde::Deserialize)]
struct AuthenticatePayload {
    token: String,
}

#[derive(serde::Serialize)]
struct AuthenticateResponsePayload {
    authenticated: bool,
}

#[derive(Clone)]
pub struct ShutdownHandle {
    signal: Arc<AtomicBool>,
    socket_path: PathBuf,
}

impl ShutdownHandle {
    pub fn shutdown(&self) {
        self.signal.store(true, Ordering::SeqCst);
        // Probe connect to unblock listener.accept()
        let _ = UnixStream::connect(&self.socket_path);
    }
}

pub struct IpcServer {
    config: IpcServerConfig,
    token: String,
    listener: Option<UnixListener>,
    _lock: SingleInstanceLock,
    active_clients: Arc<AtomicUsize>,
    shutdown_signal: Arc<AtomicBool>,
    inspector: Arc<Inspector>,
}

impl IpcServer {
    pub fn new(config: IpcServerConfig) -> io::Result<Self> {
        Self::with_inspector(config, Arc::new(Inspector::new()))
    }

    pub fn with_inspector(config: IpcServerConfig, inspector: Arc<Inspector>) -> io::Result<Self> {
        setup_runtime_dir(&config.runtime_dir)?;

        let lock = SingleInstanceLock::acquire(&config.runtime_dir)?;
        let socket_path = config.runtime_dir.join("agent.sock");
        let listener = recover_stale_socket_and_bind(&socket_path)?;

        let token = auth::generate_token()?;
        let token_path = config.runtime_dir.join("auth.token");
        auth::write_token_file(&token_path, &token)?;

        Ok(Self {
            config,
            token,
            listener: Some(listener),
            _lock: lock,
            active_clients: Arc::new(AtomicUsize::new(0)),
            shutdown_signal: Arc::new(AtomicBool::new(false)),
            inspector,
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn socket_path(&self) -> PathBuf {
        self.config.runtime_dir.join("agent.sock")
    }

    pub fn token_path(&self) -> PathBuf {
        self.config.runtime_dir.join("auth.token")
    }

    pub fn shutdown_handle(&self) -> ShutdownHandle {
        ShutdownHandle {
            signal: self.shutdown_signal.clone(),
            socket_path: self.socket_path(),
        }
    }

    pub fn run(mut self) {
        let listener = match self.listener.take() {
            Some(l) => l,
            None => return,
        };

        info!(
            "ShadowShield IPC daemon listening on {:?}",
            self.socket_path()
        );

        while !self.shutdown_signal.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    if self.shutdown_signal.load(Ordering::SeqCst) {
                        break;
                    }

                    // 1. Kernel Peer Credential Check
                    match verify_peer_credentials(&stream) {
                        Ok(true) => (),
                        Ok(false) => {
                            warn!("Rejected client with mismatched EUID");
                            continue;
                        }
                        Err(e) => {
                            warn!("Failed to query peer credentials: {:?}", e);
                            continue;
                        }
                    }

                    // 2. Concurrency Limit Guard
                    let current = self.active_clients.load(Ordering::Relaxed);
                    if current >= self.config.max_clients {
                        warn!(
                            "Max client connections reached ({}/{}), dropping connection",
                            current, self.config.max_clients
                        );
                        continue;
                    }

                    let active_counter = self.active_clients.clone();
                    let token = self.token.clone();
                    let handshake_timeout = self.config.handshake_timeout;
                    let idle_timeout = self.config.idle_timeout;
                    let inspector = self.inspector.clone();

                    thread::spawn(move || {
                        active_counter.fetch_add(1, Ordering::SeqCst);
                        handle_client(stream, &token, handshake_timeout, idle_timeout, inspector);
                        active_counter.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) => {
                    if self.shutdown_signal.load(Ordering::SeqCst) {
                        break;
                    }
                    error!("Error accepting client connection: {:?}", e);
                }
            }
        }

        info!("IPC listener shutting down.");
    }
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        let socket = self.socket_path();
        let token = self.token_path();
        let _ = fs::remove_file(socket);
        let _ = fs::remove_file(token);
    }
}

fn handle_client(
    mut stream: UnixStream,
    expected_token: &str,
    handshake_timeout: Duration,
    idle_timeout: Duration,
    inspector: Arc<Inspector>,
) {
    let handshake_deadline = Instant::now() + handshake_timeout;

    let remaining_handshake = || -> Option<Duration> {
        let now = Instant::now();
        if now >= handshake_deadline {
            None
        } else {
            Some(handshake_deadline - now)
        }
    };

    // -------------------------------------------------------------------------
    // Phase 1: Pre-Auth Phase (First message MUST be Authenticate)
    // -------------------------------------------------------------------------
    let initial_timeout = match remaining_handshake() {
        Some(t) => t,
        None => return,
    };
    let _ = stream.set_read_timeout(Some(initial_timeout));

    // Read the very first frame
    let first_req: IpcRequest = match read_message::<_, IpcRequest>(&mut stream) {
        Ok(r) => r,
        Err(FramingError::MessageTooLarge(size)) => {
            let _ = write_error(
                &mut stream,
                None,
                "message_too_large",
                &format!("Message exceeded size limit: {}", size),
            );
            return;
        }
        Err(FramingError::Json(_)) | Err(FramingError::Utf8(_)) => {
            let _ = write_error(
                &mut stream,
                None,
                "malformed_message",
                "Malformed JSON or empty frame",
            );
            return;
        }
        Err(e) => {
            warn!("Handshake read error: {:?}", e);
            return;
        }
    };

    // First frame MUST be Authenticate
    if first_req.msg_type != "Authenticate" {
        warn!(
            "Client sent {} instead of Authenticate as first frame",
            first_req.msg_type
        );
        let _ = write_error(
            &mut stream,
            Some(first_req.request_id),
            "unauthorized",
            "Authentication required before protocol interaction",
        );
        return;
    }

    let auth_payload: AuthenticatePayload = match serde_json::from_value(first_req.payload) {
        Ok(p) => p,
        Err(_) => {
            let _ = write_error(
                &mut stream,
                Some(first_req.request_id),
                "malformed_message",
                "Invalid Authenticate payload",
            );
            return;
        }
    };

    if !constant_time_eq(auth_payload.token.as_bytes(), expected_token.as_bytes()) {
        warn!("Client failed token authentication");
        let _ = write_error(
            &mut stream,
            Some(first_req.request_id),
            "unauthorized",
            "Invalid authentication token",
        );
        return;
    }

    // Authentication succeeded
    let auth_resp = IpcResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: first_req.request_id,
        msg_type: "AuthenticateResponse".to_string(),
        payload: serde_json::to_value(AuthenticateResponsePayload {
            authenticated: true,
        })
        .unwrap(),
    };
    if let Err(e) = write_message(&mut stream, &auth_resp) {
        warn!("Failed to write AuthenticateResponse: {:?}", e);
        return;
    }

    // -------------------------------------------------------------------------
    // Phase 2: AuthenticatedPreHello Phase (Second message MUST be Hello, within shared 5s deadline)
    // -------------------------------------------------------------------------
    let remaining = match remaining_handshake() {
        Some(t) => t,
        None => {
            warn!("Handshake deadline expired before Hello");
            return;
        }
    };
    let _ = stream.set_read_timeout(Some(remaining));

    let second_req: IpcRequest = match read_message::<_, IpcRequest>(&mut stream) {
        Ok(r) => r,
        Err(FramingError::MessageTooLarge(size)) => {
            let _ = write_error(
                &mut stream,
                None,
                "message_too_large",
                &format!("Message exceeded size limit: {}", size),
            );
            return;
        }
        Err(FramingError::Json(_)) | Err(FramingError::Utf8(_)) => {
            let _ = write_error(
                &mut stream,
                None,
                "malformed_message",
                "Malformed JSON or empty frame",
            );
            return;
        }
        Err(e) => {
            warn!("Handshake read error waiting for Hello: {:?}", e);
            return;
        }
    };

    if second_req.msg_type != "Hello" {
        warn!(
            "Client sent {} instead of Hello while in AuthenticatedPreHello",
            second_req.msg_type
        );
        let _ = write_error(
            &mut stream,
            Some(second_req.request_id),
            "unauthorized",
            "Hello required before operational requests",
        );
        return;
    }

    if second_req.protocol_version != PROTOCOL_VERSION {
        let _ = write_error(
            &mut stream,
            Some(second_req.request_id),
            "unsupported_protocol",
            &format!(
                "Unsupported protocol version: {}",
                second_req.protocol_version
            ),
        );
        return;
    }

    let hello: HelloRequest = match serde_json::from_value(second_req.payload) {
        Ok(v) => v,
        Err(_) => {
            let _ = write_error(
                &mut stream,
                Some(second_req.request_id),
                "malformed_message",
                "Invalid Hello payload",
            );
            return;
        }
    };

    let hello_resp = IpcResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id: second_req.request_id,
        msg_type: "HelloResponse".to_string(),
        payload: serde_json::to_value(HelloResponse {
            agent_version: AGENT_VERSION.to_string(),
            protocol_version: PROTOCOL_VERSION,
            compatible: hello.protocol_version == PROTOCOL_VERSION,
        })
        .unwrap(),
    };
    if let Err(e) = write_message(&mut stream, &hello_resp) {
        warn!("Failed to write HelloResponse: {:?}", e);
        return;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Operational Phase (Idle timeout applies)
    // -------------------------------------------------------------------------
    let _ = stream.set_read_timeout(Some(idle_timeout));

    loop {
        let req = match read_message::<_, IpcRequest>(&mut stream) {
            Ok(r) => r,
            Err(FramingError::ConnectionClosed) => {
                break;
            }
            Err(FramingError::MessageTooLarge(size)) => {
                let _ = write_error(
                    &mut stream,
                    None,
                    "message_too_large",
                    &format!("Message exceeded size limit: {}", size),
                );
                break;
            }
            Err(FramingError::Json(_)) | Err(FramingError::Utf8(_)) => {
                let _ = write_error(
                    &mut stream,
                    None,
                    "malformed_message",
                    "Malformed JSON or empty frame",
                );
                break;
            }
            Err(e) => {
                // If it was an idle timeout or network error
                warn!("Client read error: {:?}", e);
                break;
            }
        };

        if req.protocol_version != PROTOCOL_VERSION {
            let _ = write_error(
                &mut stream,
                Some(req.request_id),
                "unsupported_protocol",
                &format!("Unsupported protocol version: {}", req.protocol_version),
            );
            continue;
        }

        match req.msg_type.as_str() {
            "Hello" => {
                let hello: HelloRequest = match serde_json::from_value(req.payload) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = write_error(
                            &mut stream,
                            Some(req.request_id),
                            "malformed_message",
                            "Invalid Hello payload",
                        );
                        continue;
                    }
                };

                let resp = IpcResponse {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: req.request_id,
                    msg_type: "HelloResponse".to_string(),
                    payload: serde_json::to_value(HelloResponse {
                        agent_version: AGENT_VERSION.to_string(),
                        protocol_version: PROTOCOL_VERSION,
                        compatible: hello.protocol_version == PROTOCOL_VERSION,
                    })
                    .unwrap(),
                };
                if let Err(e) = write_message(&mut stream, &resp) {
                    warn!("Failed to write HelloResponse: {:?}", e);
                    break;
                }
            }
            "Health" => {
                let resp = IpcResponse {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: req.request_id,
                    msg_type: "HealthResponse".to_string(),
                    payload: serde_json::to_value(HealthResponse {
                        agent_running: true,
                        inspection_engine_available: true,
                        protocol_version: PROTOCOL_VERSION,
                    })
                    .unwrap(),
                };
                if let Err(e) = write_message(&mut stream, &resp) {
                    warn!("Failed to write HealthResponse: {:?}", e);
                    break;
                }
            }
            "EvaluateAiAccess" => {
                let eval_req: EvaluateAiAccessRequest = match serde_json::from_value(req.payload) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = write_error(
                            &mut stream,
                            Some(req.request_id),
                            "malformed_message",
                            "Invalid EvaluateAiAccess payload",
                        );
                        continue;
                    }
                };

                let service_id_parsed = match AiServiceId::new(&eval_req.service_id) {
                    Ok(id) => id,
                    Err(e) => {
                        let _ = write_error(
                            &mut stream,
                            Some(req.request_id),
                            "invalid_request",
                            &format!("Invalid AiServiceId: {}", e),
                        );
                        continue;
                    }
                };

                let assessment = inspector.evaluate_ai_access(&service_id_parsed, &eval_req.mode);

                let resp = IpcResponse {
                    protocol_version: PROTOCOL_VERSION,
                    request_id: req.request_id,
                    msg_type: "EvaluateAiAccessResponse".to_string(),
                    payload: serde_json::to_value(EvaluateAiAccessResponse {
                        service_id: assessment.service_id.as_str().to_string(),
                        classification: assessment.classification,
                        mode: assessment.mode,
                        decision: assessment.decision,
                        reason: assessment.reason,
                    })
                    .unwrap(),
                };
                if let Err(e) = write_message(&mut stream, &resp) {
                    warn!("Failed to write EvaluateAiAccessResponse: {:?}", e);
                    break;
                }
            }
            "Inspect" => {
                let inspect_req: InspectRequest = match serde_json::from_value(req.payload) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = write_error(
                            &mut stream,
                            Some(req.request_id),
                            "malformed_message",
                            "Invalid Inspect payload",
                        );
                        continue;
                    }
                };

                let source = match inspect_req.source.as_str() {
                    "BrowserExtension" | "Chrome" => InspectionSource::BrowserExtension,
                    _ => InspectionSource::Unknown,
                };

                let inspection_req = InspectionRequest {
                    request_id: req.request_id.clone(),
                    source,
                    ai_service: inspect_req.ai_service,
                    content: SensitiveText::new(inspect_req.content),
                    timestamp: inspect_req.timestamp,
                };

                match inspector.inspect(inspection_req) {
                    Ok(result) => {
                        let resp = IpcResponse {
                            protocol_version: PROTOCOL_VERSION,
                            request_id: req.request_id,
                            msg_type: "InspectResponse".to_string(),
                            payload: serde_json::to_value(InspectResponse {
                                detections_count: result.detections.len(),
                                detections: result.detections,
                                risk_assessment: result.risk_assessment,
                                action: result.action,
                                sanitized_content: result
                                    .sanitized_content
                                    .map(|s| s.expose().to_string()),
                                processing_duration_ms: result.processing_duration_ms,
                            })
                            .unwrap(),
                        };
                        if let Err(e) = write_message(&mut stream, &resp) {
                            warn!("Failed to write InspectResponse: {:?}", e);
                            break;
                        }
                    }
                    Err(InspectorError::InvalidRequest(msg)) => {
                        let _ =
                            write_error(&mut stream, Some(req.request_id), "invalid_request", &msg);
                    }
                    Err(e) => {
                        let _ = write_error(
                            &mut stream,
                            Some(req.request_id),
                            "internal_error",
                            &format!("Inspection failed: {:?}", e),
                        );
                    }
                }
            }
            unknown => {
                let _ = write_error(
                    &mut stream,
                    Some(req.request_id),
                    "invalid_request",
                    &format!("Unknown message type: {}", unknown),
                );
            }
        }
    }
}

fn write_error(
    stream: &mut UnixStream,
    request_id: Option<String>,
    code: &str,
    message: &str,
) -> io::Result<()> {
    let err = IpcErrorResponse {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        msg_type: "Error".to_string(),
        payload: IpcErrorPayload {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    let _ = write_message(stream, &err);
    Ok(())
}
