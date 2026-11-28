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
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::auth::{self, constant_time_eq, verify_peer_credentials};
use super::framing::{
    read_message_with_deadlines, write_message, FramingError, DEFAULT_FRAME_TIMEOUT,
};
use super::transport::{
    default_runtime_dir, recover_stale_socket_and_bind, setup_runtime_dir, SingleInstanceLock,
};

const PROTOCOL_VERSION: u32 = 1;
const AGENT_VERSION: &str = "0.1.0-dev";
pub const DEFAULT_MAX_CLIENTS: usize = 16;
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
pub const DEFAULT_SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct IpcServerConfig {
    pub runtime_dir: PathBuf,
    pub max_clients: usize,
    pub handshake_timeout: Duration,
    pub idle_timeout: Duration,
    pub frame_timeout: Duration,
    pub shutdown_grace_period: Duration,
}

impl Default for IpcServerConfig {
    fn default() -> Self {
        Self {
            runtime_dir: default_runtime_dir(),
            max_clients: DEFAULT_MAX_CLIENTS,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            frame_timeout: DEFAULT_FRAME_TIMEOUT,
            shutdown_grace_period: DEFAULT_SHUTDOWN_GRACE_PERIOD,
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
    active_clients: Arc<AtomicUsize>,
}

impl ShutdownHandle {
    pub fn shutdown(&self) {
        self.signal.store(true, Ordering::SeqCst);
        // Probe connect to unblock listener.accept()
        let _ = UnixStream::connect(&self.socket_path);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.signal.load(Ordering::SeqCst)
    }

    pub fn active_clients_count(&self) -> usize {
        self.active_clients.load(Ordering::SeqCst)
    }
}

struct WorkerGuard {
    active_counter: Arc<AtomicUsize>,
    worker_tracker: Arc<(Mutex<usize>, Condvar)>,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        self.active_counter.fetch_sub(1, Ordering::SeqCst);
        let (lock, cvar) = &*self.worker_tracker;
        let mut count = lock.lock().unwrap_or_else(|e| e.into_inner());
        *count = count.saturating_sub(1);
        cvar.notify_all();
    }
}

pub struct IpcServer {
    config: IpcServerConfig,
    token: String,
    listener: Option<UnixListener>,
    _lock: SingleInstanceLock,
    active_clients: Arc<AtomicUsize>,
    shutdown_signal: Arc<AtomicBool>,
    worker_tracker: Arc<(Mutex<usize>, Condvar)>,
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
            worker_tracker: Arc::new((Mutex::new(0), Condvar::new())),
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
            active_clients: self.active_clients.clone(),
        }
    }

    pub fn active_clients_count(&self) -> usize {
        self.active_clients.load(Ordering::SeqCst)
    }

    pub fn run(mut self) -> bool {
        let listener = match self.listener.take() {
            Some(l) => l,
            None => return false,
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
                    let worker_tracker = self.worker_tracker.clone();
                    let token = self.token.clone();
                    let config = self.config.clone();
                    let inspector = self.inspector.clone();
                    let shutdown_signal = self.shutdown_signal.clone();

                    active_counter.fetch_add(1, Ordering::SeqCst);
                    {
                        let (lock, _) = &*worker_tracker;
                        *lock.lock().unwrap_or_else(|e| e.into_inner()) += 1;
                    }

                    thread::spawn(move || {
                        let _guard = WorkerGuard {
                            active_counter,
                            worker_tracker,
                        };
                        handle_client(stream, &token, &config, inspector, shutdown_signal);
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

        info!(
            "IPC listener loop stopped. Draining active workers (grace period: {:?})...",
            self.config.shutdown_grace_period
        );

        // Bounded graceful drain
        let (lock, cvar) = &*self.worker_tracker;
        let mut count = lock.lock().unwrap_or_else(|e| e.into_inner());
        let start = Instant::now();
        while *count > 0 {
            let elapsed = start.elapsed();
            if elapsed >= self.config.shutdown_grace_period {
                warn!(
                    "Shutdown grace period expired with {} active workers remaining",
                    *count
                );
                break;
            }
            let rem = self.config.shutdown_grace_period - elapsed;
            let (new_guard, timeout_res) = cvar
                .wait_timeout(count, rem)
                .unwrap_or_else(|e| e.into_inner());
            count = new_guard;
            if timeout_res.timed_out() && *count > 0 {
                warn!(
                    "Shutdown grace period expired with {} active workers remaining",
                    *count
                );
                break;
            }
        }

        let clean = *count == 0;
        if clean {
            info!("All workers terminated cleanly within grace period.");
        }
        clean
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
    config: &IpcServerConfig,
    inspector: Arc<Inspector>,
    shutdown_signal: Arc<AtomicBool>,
) {
    let handshake_deadline = Instant::now() + config.handshake_timeout;

    if shutdown_signal.load(Ordering::SeqCst) {
        return;
    }

    // -------------------------------------------------------------------------
    // Phase 1: Pre-Auth Phase (First message MUST be Authenticate)
    // -------------------------------------------------------------------------
    let first_req: IpcRequest = match read_message_with_deadlines::<IpcRequest>(
        &mut stream,
        None,
        config.frame_timeout,
        Some(handshake_deadline),
    ) {
        Ok(r) => r,
        Err(FramingError::TimedOut) => {
            warn!("Handshake read timeout waiting for Authenticate");
            return;
        }
        Err(FramingError::ConnectionClosed) => return,
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
    if shutdown_signal.load(Ordering::SeqCst) {
        return;
    }

    if Instant::now() >= handshake_deadline {
        warn!("Handshake deadline expired before Hello");
        return;
    }

    let second_req: IpcRequest = match read_message_with_deadlines::<IpcRequest>(
        &mut stream,
        None,
        config.frame_timeout,
        Some(handshake_deadline),
    ) {
        Ok(r) => r,
        Err(FramingError::TimedOut) => {
            warn!("Handshake read timeout waiting for Hello");
            return;
        }
        Err(FramingError::ConnectionClosed) => return,
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
    // Phase 3: Operational Phase (Idle timeout and absolute frame deadlines apply)
    // -------------------------------------------------------------------------
    loop {
        if shutdown_signal.load(Ordering::SeqCst) {
            break;
        }

        let req = match read_message_with_deadlines::<IpcRequest>(
            &mut stream,
            Some(config.idle_timeout),
            config.frame_timeout,
            None,
        ) {
            Ok(r) => r,
            Err(FramingError::ConnectionClosed) => {
                break;
            }
            Err(FramingError::TimedOut) => {
                warn!("Frame reception timed out or idle limit reached, closing connection");
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

        if shutdown_signal.load(Ordering::SeqCst) {
            break;
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
