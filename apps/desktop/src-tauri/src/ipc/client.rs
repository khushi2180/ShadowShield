use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::framing::{read_message, write_message, FramingError};
use super::protocol::{
    AuthenticateRequest, AuthenticateResponse, HealthRequest, HealthResponse, HelloRequest,
    HelloResponse, IpcErrorPayload, IpcRequest, SanitizedHealthStatus, TokenSecret,
    TrayHealthState, PROTOCOL_VERSION, UNMONITORED_LABEL,
};

pub const TRAY_HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
pub const TRAY_POLL_INTERVAL: Duration = Duration::from_secs(5);
pub const DEFAULT_RECONNECT_BASE_DELAY: Duration = Duration::from_secs(5);
pub const DEFAULT_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);
const TRAY_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcPaths {
    pub runtime_dir: PathBuf,
    pub socket_path: PathBuf,
    pub token_path: PathBuf,
}

impl IpcPaths {
    pub fn from_runtime_dir(runtime_dir: PathBuf) -> Self {
        let socket_path = runtime_dir.join("agent.sock");
        let token_path = runtime_dir.join("auth.token");
        Self {
            runtime_dir,
            socket_path,
            token_path,
        }
    }
}

/// Returns the canonical contract runtime directory:
/// `~/Library/Application Support/ShadowShield/run/` on macOS.
pub fn default_runtime_dir() -> PathBuf {
    if let Ok(home) = env::var("HOME") {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("ShadowShield")
            .join("run")
    } else {
        #[cfg(unix)]
        {
            // Fallback matching apps/agent/src/ipc/transport.rs when HOME is unset.
            let uid = unsafe { libc_getuid() };
            PathBuf::from("/tmp")
                .join(format!("shadowshield-{}", uid))
                .join("run")
        }
        #[cfg(not(unix))]
        {
            env::temp_dir().join("shadowshield").join("run")
        }
    }
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

pub trait IpcStream: Read + Write + Send {
    fn set_timeout(&mut self, timeout: Duration) -> io::Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    SocketUnavailable,
    TokenMissing,
    TokenUnreadable,
    TimedOut,
}

pub trait IpcTransport: Send {
    fn read_token(&self) -> Result<TokenSecret, ConnectError>;
    fn connect(&self, timeout: Duration) -> Result<Box<dyn IpcStream>, ConnectError>;
}

pub fn read_token_from_path(path: &Path) -> Result<TokenSecret, ConnectError> {
    let raw = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(ConnectError::TokenMissing),
        Err(_) => return Err(ConnectError::TokenUnreadable),
    };
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        return Err(ConnectError::TokenUnreadable);
    }
    Ok(TokenSecret::new(trimmed))
}

#[cfg(unix)]
pub struct UnixIpcTransport {
    paths: IpcPaths,
}

#[cfg(unix)]
impl UnixIpcTransport {
    pub fn new(paths: IpcPaths) -> Self {
        Self { paths }
    }
}

#[cfg(unix)]
struct UnixStreamWrapper(std::os::unix::net::UnixStream);

#[cfg(unix)]
impl Read for UnixStreamWrapper {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

#[cfg(unix)]
impl Write for UnixStreamWrapper {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

#[cfg(unix)]
impl IpcStream for UnixStreamWrapper {
    fn set_timeout(&mut self, timeout: Duration) -> io::Result<()> {
        self.0.set_read_timeout(Some(timeout))?;
        self.0.set_write_timeout(Some(timeout))?;
        Ok(())
    }
}

#[cfg(unix)]
impl IpcTransport for UnixIpcTransport {
    fn read_token(&self) -> Result<TokenSecret, ConnectError> {
        read_token_from_path(&self.paths.token_path)
    }

    fn connect(&self, timeout: Duration) -> Result<Box<dyn IpcStream>, ConnectError> {
        let stream = std::os::unix::net::UnixStream::connect(&self.paths.socket_path)
            .map_err(|_| ConnectError::SocketUnavailable)?;
        let mut wrapped = UnixStreamWrapper(stream);
        wrapped
            .set_timeout(timeout)
            .map_err(|_| ConnectError::SocketUnavailable)?;
        Ok(Box::new(wrapped))
    }
}

#[cfg(not(unix))]
pub struct UnsupportedPlatformTransport;

#[cfg(not(unix))]
impl IpcTransport for UnsupportedPlatformTransport {
    fn read_token(&self) -> Result<TokenSecret, ConnectError> {
        Err(ConnectError::SocketUnavailable)
    }

    fn connect(&self, _timeout: Duration) -> Result<Box<dyn IpcStream>, ConnectError> {
        Err(ConnectError::SocketUnavailable)
    }
}

#[cfg(unix)]
pub type DefaultTransport = UnixIpcTransport;
#[cfg(not(unix))]
pub type DefaultTransport = UnsupportedPlatformTransport;

pub fn default_transport() -> DefaultTransport {
    #[cfg(unix)]
    {
        UnixIpcTransport::new(IpcPaths::from_runtime_dir(default_runtime_dir()))
    }
    #[cfg(not(unix))]
    {
        UnsupportedPlatformTransport
    }
}

#[derive(serde::Deserialize)]
struct RawEnvelope {
    protocol_version: u32,
    request_id: Option<String>,
    #[serde(rename = "type")]
    msg_type: String,
    payload: serde_json::Value,
}

struct ActiveSession {
    stream: Box<dyn IpcStream>,
    agent_version: String,
}

enum StepFailure {
    Offline(&'static str),
    Stale(&'static str),
}

struct ReconnectBackoff {
    consecutive_failures: u32,
    next_retry_at: Option<Instant>,
    base_delay: Duration,
    max_delay: Duration,
    last_failure_state: TrayHealthState,
    last_failure_reason: &'static str,
}

impl ReconnectBackoff {
    fn new(base_delay: Duration, max_delay: Duration) -> Self {
        Self {
            consecutive_failures: 0,
            next_retry_at: None,
            base_delay,
            max_delay,
            last_failure_state: TrayHealthState::Offline,
            last_failure_reason: "Agent socket unavailable",
        }
    }

    fn should_attempt(&self, now: Instant) -> bool {
        self.next_retry_at.map_or(true, |retry_at| now >= retry_at)
    }

    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.next_retry_at = None;
    }

    fn record_failure(&mut self, now: Instant, state: TrayHealthState, reason: &'static str) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures == 1 {
            // Allow one immediate retry for transient agent-restart / token-rotation recovery
            // before engaging exponential backoff.
            self.next_retry_at = None;
        } else {
            let shift = (self.consecutive_failures - 2).min(10);
            let delay = self
                .base_delay
                .saturating_mul(1u32 << shift)
                .min(self.max_delay);
            self.next_retry_at = Some(now + delay);
        }
        self.last_failure_state = state;
        self.last_failure_reason = reason;
    }
}

pub struct IpcHealthClient<T: IpcTransport> {
    transport: T,
    health_timeout: Duration,
    request_counter: u64,
    session: Option<ActiveSession>,
    backoff: ReconnectBackoff,
}

impl<T: IpcTransport> IpcHealthClient<T> {
    pub fn new(transport: T) -> Self {
        Self::with_timeout_and_backoff(
            transport,
            TRAY_HEALTH_TIMEOUT,
            DEFAULT_RECONNECT_BASE_DELAY,
            DEFAULT_RECONNECT_MAX_DELAY,
        )
    }

    pub fn with_timeout(transport: T, health_timeout: Duration) -> Self {
        Self::with_timeout_and_backoff(
            transport,
            health_timeout,
            DEFAULT_RECONNECT_BASE_DELAY,
            DEFAULT_RECONNECT_MAX_DELAY,
        )
    }

    pub fn with_timeout_and_backoff(
        transport: T,
        health_timeout: Duration,
        base_delay: Duration,
        max_delay: Duration,
    ) -> Self {
        Self {
            transport,
            health_timeout,
            request_counter: 0,
            session: None,
            backoff: ReconnectBackoff::new(base_delay, max_delay),
        }
    }

    pub fn has_active_session(&self) -> bool {
        self.session.is_some()
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.backoff.consecutive_failures
    }

    pub fn shutdown(&mut self) {
        self.session = None;
    }

    fn next_request_id(&mut self, prefix: &str) -> String {
        self.request_counter += 1;
        format!("{}-{}", prefix, self.request_counter)
    }

    /// Executes a single health poll within the 3-second TRAY_HEALTH_TIMEOUT deadline.
    /// Connects and runs Authenticate -> Hello when no active session exists,
    /// re-reading auth.token on every reconnect, with bounded exponential backoff.
    pub fn poll_health(&mut self) -> SanitizedHealthStatus {
        self.poll_health_at(Instant::now())
    }

    pub fn poll_health_at(&mut self, now: Instant) -> SanitizedHealthStatus {
        let deadline = Instant::now() + self.health_timeout;

        if self.session.is_none() {
            if !self.backoff.should_attempt(now) {
                return sanitized_status(
                    self.backoff.last_failure_state,
                    None,
                    None,
                    self.backoff.last_failure_reason,
                );
            }

            match self.connect_and_handshake(deadline) {
                Ok(session) => {
                    self.session = Some(session);
                }
                Err(StepFailure::Stale(reason)) => {
                    self.backoff
                        .record_failure(now, TrayHealthState::Stale, reason);
                    return sanitized_status(TrayHealthState::Stale, None, None, reason);
                }
                Err(StepFailure::Offline(reason)) => {
                    self.backoff
                        .record_failure(now, TrayHealthState::Offline, reason);
                    return sanitized_status(TrayHealthState::Offline, None, None, reason);
                }
            }
        }

        let remaining = match remaining_until(deadline) {
            Some(d) => d,
            None => {
                self.session = None;
                let reason = "Health check exceeded 3000 ms timeout";
                self.backoff
                    .record_failure(now, TrayHealthState::Stale, reason);
                return sanitized_status(TrayHealthState::Stale, None, None, reason);
            }
        };

        let req_id = self.next_request_id("tray-health");
        let req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: req_id.clone(),
            msg_type: "Health".to_string(),
            payload: serde_json::to_value(HealthRequest {}).unwrap_or(serde_json::json!({})),
        };

        let (health_res, agent_version) = {
            let session = match self.session.as_mut() {
                Some(s) => s,
                None => {
                    return sanitized_status(
                        TrayHealthState::Offline,
                        None,
                        None,
                        "Agent session unavailable",
                    );
                }
            };

            if session.stream.set_timeout(remaining).is_err() {
                self.session = None;
                let reason = "Agent socket unavailable";
                self.backoff
                    .record_failure(now, TrayHealthState::Offline, reason);
                return sanitized_status(TrayHealthState::Offline, None, None, reason);
            }

            let res = send_and_expect(
                session.stream.as_mut(),
                &req,
                &req_id,
                "HealthResponse",
                deadline,
            );
            (res, session.agent_version.clone())
        };

        match health_res {
            Ok(payload) => {
                let health: HealthResponse = match serde_json::from_value(payload) {
                    Ok(h) => h,
                    Err(_) => {
                        self.session = None;
                        let reason = "Malformed HealthResponse payload";
                        self.backoff
                            .record_failure(now, TrayHealthState::Offline, reason);
                        return sanitized_status(TrayHealthState::Offline, None, None, reason);
                    }
                };

                if health.protocol_version != PROTOCOL_VERSION {
                    self.session = None;
                    let reason = "Protocol version mismatch";
                    self.backoff
                        .record_failure(now, TrayHealthState::Offline, reason);
                    return sanitized_status(TrayHealthState::Offline, None, None, reason);
                }

                let state = if !health.agent_running {
                    TrayHealthState::Offline
                } else if !health.inspection_engine_available {
                    TrayHealthState::Degraded
                } else {
                    TrayHealthState::Online
                };

                let reason = match state {
                    TrayHealthState::Online => "Core inspection engine ready",
                    TrayHealthState::Degraded => "Inspection engine unavailable",
                    TrayHealthState::Offline => "Agent reported not running",
                    TrayHealthState::Stale => "Health check timed out",
                };

                self.backoff.record_success();
                sanitized_status(state, Some(health), Some(agent_version), reason)
            }
            Err(StepFailure::Stale(reason)) => {
                self.session = None;
                self.backoff
                    .record_failure(now, TrayHealthState::Stale, reason);
                sanitized_status(TrayHealthState::Stale, None, None, reason)
            }
            Err(StepFailure::Offline(reason)) => {
                self.session = None;
                self.backoff
                    .record_failure(now, TrayHealthState::Offline, reason);
                sanitized_status(TrayHealthState::Offline, None, None, reason)
            }
        }
    }

    fn connect_and_handshake(&mut self, deadline: Instant) -> Result<ActiveSession, StepFailure> {
        let token = self.transport.read_token().map_err(|e| match e {
            ConnectError::TokenMissing => StepFailure::Offline("Authentication token missing"),
            ConnectError::TokenUnreadable => {
                StepFailure::Offline("Authentication token unreadable")
            }
            ConnectError::SocketUnavailable => StepFailure::Offline("Agent socket unavailable"),
            ConnectError::TimedOut => StepFailure::Stale("Health check exceeded 3000 ms timeout"),
        })?;

        let remaining = remaining_until(deadline)
            .ok_or(StepFailure::Stale("Health check exceeded 3000 ms timeout"))?;
        let mut stream = self.transport.connect(remaining).map_err(|e| match e {
            ConnectError::TimedOut => StepFailure::Stale("Health check exceeded 3000 ms timeout"),
            _ => StepFailure::Offline("Agent socket unavailable"),
        })?;

        // Phase 1: Authenticate
        let auth_id = self.next_request_id("tray-auth");
        let auth_req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: auth_id.clone(),
            msg_type: "Authenticate".to_string(),
            payload: serde_json::to_value(AuthenticateRequest {
                token: token.expose().to_string(),
            })
            .map_err(|_| StepFailure::Offline("Failed to serialize Authenticate request"))?,
        };
        drop(token);

        let auth_payload = send_and_expect(
            stream.as_mut(),
            &auth_req,
            &auth_id,
            "AuthenticateResponse",
            deadline,
        )?;

        let auth_resp: AuthenticateResponse = serde_json::from_value(auth_payload)
            .map_err(|_| StepFailure::Offline("Malformed AuthenticateResponse payload"))?;
        if !auth_resp.authenticated {
            return Err(StepFailure::Offline("Authentication rejected"));
        }

        // Phase 2: Hello
        let remaining_hello = remaining_until(deadline)
            .ok_or(StepFailure::Stale("Health check exceeded 3000 ms timeout"))?;
        let _ = stream.set_timeout(remaining_hello);

        let hello_id = self.next_request_id("tray-hello");
        let hello_req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: hello_id.clone(),
            msg_type: "Hello".to_string(),
            payload: serde_json::to_value(HelloRequest {
                extension_version: TRAY_CLIENT_VERSION.to_string(),
                protocol_version: PROTOCOL_VERSION,
            })
            .map_err(|_| StepFailure::Offline("Failed to serialize Hello request"))?,
        };

        let hello_payload = send_and_expect(
            stream.as_mut(),
            &hello_req,
            &hello_id,
            "HelloResponse",
            deadline,
        )?;

        let hello_resp: HelloResponse = serde_json::from_value(hello_payload)
            .map_err(|_| StepFailure::Offline("Malformed HelloResponse payload"))?;
        if hello_resp.protocol_version != PROTOCOL_VERSION || !hello_resp.compatible {
            return Err(StepFailure::Offline("Protocol version mismatch"));
        }

        Ok(ActiveSession {
            stream,
            agent_version: hello_resp.agent_version,
        })
    }
}

fn remaining_until(deadline: Instant) -> Option<Duration> {
    let now = Instant::now();
    if now >= deadline {
        None
    } else {
        Some(deadline - now)
    }
}

fn send_and_expect(
    stream: &mut dyn IpcStream,
    req: &IpcRequest,
    expected_request_id: &str,
    expected_msg_type: &str,
    deadline: Instant,
) -> Result<serde_json::Value, StepFailure> {
    if Instant::now() >= deadline {
        return Err(StepFailure::Stale("Health check exceeded 3000 ms timeout"));
    }

    write_message(stream, req).map_err(|e| match e {
        FramingError::TimedOut => StepFailure::Stale("Health check exceeded 3000 ms timeout"),
        FramingError::MessageTooLarge(_) => StepFailure::Offline("Outgoing frame exceeded 10 MiB"),
        _ => StepFailure::Offline("Agent connection lost"),
    })?;

    if Instant::now() >= deadline {
        return Err(StepFailure::Stale("Health check exceeded 3000 ms timeout"));
    }

    let env: RawEnvelope = read_message(stream).map_err(|e| match e {
        FramingError::TimedOut => StepFailure::Stale("Health check exceeded 3000 ms timeout"),
        FramingError::MessageTooLarge(_) => StepFailure::Offline("Oversized response frame"),
        FramingError::Json(_) | FramingError::Utf8(_) | FramingError::EmptyFrame => {
            StepFailure::Offline("Malformed response frame")
        }
        FramingError::ConnectionClosed | FramingError::Io(_) => {
            StepFailure::Offline("Agent connection lost")
        }
    })?;

    if Instant::now() >= deadline {
        return Err(StepFailure::Stale("Health check exceeded 3000 ms timeout"));
    }

    if env.protocol_version != PROTOCOL_VERSION {
        return Err(StepFailure::Offline("Protocol version mismatch"));
    }

    if env.msg_type == "Error" {
        let err_payload: IpcErrorPayload = serde_json::from_value(env.payload)
            .map_err(|_| StepFailure::Offline("Malformed IPC error response"))?;
        return Err(StepFailure::Offline(map_error_code(&err_payload.code)));
    }

    if env.request_id.as_deref() != Some(expected_request_id) {
        return Err(StepFailure::Offline("Mismatched response request_id"));
    }

    if env.msg_type != expected_msg_type {
        return Err(StepFailure::Offline("Unexpected IPC response type"));
    }

    Ok(env.payload)
}

fn map_error_code(code: &str) -> &'static str {
    match code {
        "unauthorized" => "Authentication rejected",
        "unsupported_protocol" => "Protocol version mismatch",
        "message_too_large" => "Frame exceeded 10 MiB limit",
        "malformed_message" => "Malformed IPC message",
        "handshake_timeout" | "request_timeout" => "Agent request timed out",
        _ => "Agent returned IPC error",
    }
}

fn sanitized_status(
    state: TrayHealthState,
    health: Option<HealthResponse>,
    agent_version: Option<String>,
    reason: &str,
) -> SanitizedHealthStatus {
    SanitizedHealthStatus {
        state,
        health,
        agent_version,
        browser_protection: UNMONITORED_LABEL.to_string(),
        ide_protection: UNMONITORED_LABEL.to_string(),
        status_reason: reason.to_string(),
    }
}
