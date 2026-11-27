use shadowshield_desktop_lib::ipc::client::{
    ConnectError, IpcHealthClient, IpcStream, IpcTransport, TRAY_HEALTH_TIMEOUT,
};
use shadowshield_desktop_lib::ipc::framing::MAX_FRAME_LENGTH;
use shadowshield_desktop_lib::ipc::protocol::{
    IpcRequest, TokenSecret, TrayHealthState, PROTOCOL_VERSION, UNMONITORED_LABEL,
};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
enum FaultMode {
    Normal {
        agent_running: bool,
        engine_available: bool,
    },
    ConnectionRefused,
    ConnectionResetOnHealth,
    PrematureEofOnHealth,
    ZeroLengthFrameOnHealth,
    MalformedJsonOnHealth,
    OversizedFrameOnHealth,
    WrongProtocolVersionInEnvelope,
    MismatchedRequestIdOnHealth,
    UnexpectedResponseTypeOnHealth,
    ErrorEnvelopeOnHealth,
    TimeoutOnHealth,
}

struct FaultState {
    mode: FaultMode,
    expected_token: String,
    disk_token: Option<String>,
    token_reads: AtomicUsize,
    connect_attempts: AtomicUsize,
}

#[derive(Clone)]
struct FaultTransport(Arc<Mutex<FaultState>>);

impl FaultTransport {
    fn new(token: &str, mode: FaultMode) -> Self {
        Self(Arc::new(Mutex::new(FaultState {
            mode,
            expected_token: token.to_string(),
            disk_token: Some(token.to_string()),
            token_reads: AtomicUsize::new(0),
            connect_attempts: AtomicUsize::new(0),
        })))
    }

    fn set_mode(&self, mode: FaultMode) {
        self.0.lock().unwrap().mode = mode;
    }

    fn rotate_token(&self, new_token: &str, mode: FaultMode) {
        let mut st = self.0.lock().unwrap();
        st.expected_token = new_token.to_string();
        st.disk_token = Some(new_token.to_string());
        st.mode = mode;
    }

    fn token_reads(&self) -> usize {
        self.0.lock().unwrap().token_reads.load(Ordering::SeqCst)
    }

    fn connect_attempts(&self) -> usize {
        self.0
            .lock()
            .unwrap()
            .connect_attempts
            .load(Ordering::SeqCst)
    }
}

struct FaultStream {
    shared: Arc<Mutex<FaultState>>,
    incoming: Vec<u8>,
    outgoing: VecDeque<u8>,
    fail_with_reset: bool,
    fail_with_timeout: bool,
}

impl Read for FaultStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.fail_with_timeout {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
        }
        if self.fail_with_reset {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection reset by peer",
            ));
        }
        if self.outgoing.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "premature eof",
            ));
        }
        let n = buf.len().min(self.outgoing.len());
        for slot in buf.iter_mut().take(n) {
            *slot = self.outgoing.pop_front().unwrap();
        }
        Ok(n)
    }
}

impl Write for FaultStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.incoming.extend_from_slice(buf);
        while self.incoming.len() >= 4 {
            let len = u32::from_le_bytes([
                self.incoming[0],
                self.incoming[1],
                self.incoming[2],
                self.incoming[3],
            ]) as usize;
            if self.incoming.len() < 4 + len {
                break;
            }
            let payload: Vec<u8> = self.incoming.drain(..4 + len).skip(4).collect();
            let req: IpcRequest = serde_json::from_slice(&payload).unwrap();
            self.handle_request(req);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl FaultStream {
    fn push_frame(&mut self, bytes: &[u8]) {
        self.outgoing.extend((bytes.len() as u32).to_le_bytes());
        self.outgoing.extend(bytes);
    }

    fn handle_request(&mut self, req: IpcRequest) {
        let (mode, expected_token) = {
            let st = self.shared.lock().unwrap();
            (st.mode.clone(), st.expected_token.clone())
        };

        match req.msg_type.as_str() {
            "Authenticate" => {
                let tok = req.payload["token"].as_str().unwrap_or("");
                let resp = if tok == expected_token {
                    serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "AuthenticateResponse",
                        "payload": { "authenticated": true }
                    })
                } else {
                    serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "Error",
                        "payload": { "code": "unauthorized", "message": "Invalid token" }
                    })
                };
                self.push_frame(&serde_json::to_vec(&resp).unwrap());
            }
            "Hello" => {
                let resp = serde_json::json!({
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": req.request_id,
                    "type": "HelloResponse",
                    "payload": {
                        "agent_version": "0.1.0-t4",
                        "protocol_version": PROTOCOL_VERSION,
                        "compatible": true
                    }
                });
                self.push_frame(&serde_json::to_vec(&resp).unwrap());
            }
            "Health" => match mode {
                FaultMode::Normal {
                    agent_running,
                    engine_available,
                } => {
                    let resp = serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "HealthResponse",
                        "payload": {
                            "agent_running": agent_running,
                            "inspection_engine_available": engine_available,
                            "protocol_version": PROTOCOL_VERSION
                        }
                    });
                    self.push_frame(&serde_json::to_vec(&resp).unwrap());
                }
                FaultMode::ConnectionResetOnHealth => {
                    self.fail_with_reset = true;
                }
                FaultMode::TimeoutOnHealth => {
                    self.fail_with_timeout = true;
                }
                FaultMode::PrematureEofOnHealth => {
                    // Header claims 100 bytes, only 4 bytes follow before EOF
                    self.outgoing.extend(100u32.to_le_bytes());
                    self.outgoing.extend(b"{bad");
                }
                FaultMode::ZeroLengthFrameOnHealth => {
                    self.outgoing.extend(0u32.to_le_bytes());
                }
                FaultMode::MalformedJsonOnHealth => {
                    self.push_frame(b"{not-valid-json");
                }
                FaultMode::OversizedFrameOnHealth => {
                    self.outgoing.extend((MAX_FRAME_LENGTH + 1).to_le_bytes());
                }
                FaultMode::WrongProtocolVersionInEnvelope => {
                    let resp = serde_json::json!({
                        "protocol_version": 99,
                        "request_id": req.request_id,
                        "type": "HealthResponse",
                        "payload": {
                            "agent_running": true,
                            "inspection_engine_available": true,
                            "protocol_version": 99
                        }
                    });
                    self.push_frame(&serde_json::to_vec(&resp).unwrap());
                }
                FaultMode::MismatchedRequestIdOnHealth => {
                    let resp = serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": "wrong-id",
                        "type": "HealthResponse",
                        "payload": {
                            "agent_running": true,
                            "inspection_engine_available": true,
                            "protocol_version": PROTOCOL_VERSION
                        }
                    });
                    self.push_frame(&serde_json::to_vec(&resp).unwrap());
                }
                FaultMode::UnexpectedResponseTypeOnHealth => {
                    let resp = serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "InspectResponse",
                        "payload": {}
                    });
                    self.push_frame(&serde_json::to_vec(&resp).unwrap());
                }
                FaultMode::ErrorEnvelopeOnHealth => {
                    let resp = serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "Error",
                        "payload": {
                            "code": "internal_error",
                            "message": "Simulated agent saturation"
                        }
                    });
                    self.push_frame(&serde_json::to_vec(&resp).unwrap());
                }
                FaultMode::ConnectionRefused => {}
            },
            _ => unreachable!(),
        }
    }
}

impl IpcStream for FaultStream {
    fn set_timeout(&mut self, _timeout: Duration) -> io::Result<()> {
        Ok(())
    }
}

impl IpcTransport for FaultTransport {
    fn read_token(&self) -> Result<TokenSecret, ConnectError> {
        let st = self.0.lock().unwrap();
        st.token_reads.fetch_add(1, Ordering::SeqCst);
        match &st.disk_token {
            Some(t) => Ok(TokenSecret::new(t.clone())),
            None => Err(ConnectError::TokenMissing),
        }
    }

    fn connect(&self, _timeout: Duration) -> Result<Box<dyn IpcStream>, ConnectError> {
        let st = self.0.lock().unwrap();
        st.connect_attempts.fetch_add(1, Ordering::SeqCst);
        if matches!(st.mode, FaultMode::ConnectionRefused) {
            return Err(ConnectError::SocketUnavailable);
        }
        Ok(Box::new(FaultStream {
            shared: Arc::clone(&self.0),
            incoming: Vec::new(),
            outgoing: VecDeque::new(),
            fail_with_reset: false,
            fail_with_timeout: false,
        }))
    }
}

#[test]
fn daemon_crash_after_online_discards_session_and_recovers_with_rotated_token() {
    let tok1 = "1".repeat(64);
    let tok2 = "2".repeat(64);
    let transport = FaultTransport::new(
        &tok1,
        FaultMode::Normal {
            agent_running: true,
            engine_available: true,
        },
    );
    let mut client = IpcHealthClient::with_timeout_and_backoff(
        transport.clone(),
        TRAY_HEALTH_TIMEOUT,
        Duration::from_secs(5),
        Duration::from_secs(60),
    );

    let t0 = Instant::now();
    let online = client.poll_health_at(t0);
    assert_eq!(online.state, TrayHealthState::Online);
    assert!(client.has_active_session());
    assert_eq!(online.browser_protection, UNMONITORED_LABEL);
    assert_eq!(online.ide_protection, UNMONITORED_LABEL);

    // Daemon crashes / resets connection
    transport.set_mode(FaultMode::ConnectionResetOnHealth);
    let crashed = client.poll_health_at(t0 + Duration::from_secs(5));
    assert_eq!(crashed.state, TrayHealthState::Offline);
    assert!(!client.has_active_session());
    assert!(crashed.health.is_none());

    // Daemon restarts with rotated token
    transport.rotate_token(
        &tok2,
        FaultMode::Normal {
            agent_running: true,
            engine_available: true,
        },
    );
    let recovered = client.poll_health_at(t0 + Duration::from_secs(6));
    assert_eq!(recovered.state, TrayHealthState::Online);
    assert!(client.has_active_session());
    assert_eq!(transport.token_reads(), 2);
    assert_eq!(transport.connect_attempts(), 2);
    assert!(!recovered.status_reason.contains(&tok1));
    assert!(!recovered.status_reason.contains(&tok2));
}

#[test]
fn malformed_and_protocol_faults_fail_closed_and_discard_session() {
    let token = "3".repeat(64);
    let fault_modes = [
        FaultMode::PrematureEofOnHealth,
        FaultMode::ZeroLengthFrameOnHealth,
        FaultMode::MalformedJsonOnHealth,
        FaultMode::OversizedFrameOnHealth,
        FaultMode::WrongProtocolVersionInEnvelope,
        FaultMode::MismatchedRequestIdOnHealth,
        FaultMode::UnexpectedResponseTypeOnHealth,
        FaultMode::ErrorEnvelopeOnHealth,
    ];

    for mode in fault_modes {
        let transport = FaultTransport::new(&token, mode);
        let mut client = IpcHealthClient::new(transport.clone());
        let res = client.poll_health();
        assert_eq!(res.state, TrayHealthState::Offline);
        assert!(!client.has_active_session());
        assert!(res.health.is_none());
        assert_eq!(res.browser_protection, UNMONITORED_LABEL);
        assert_eq!(res.ide_protection, UNMONITORED_LABEL);
        assert!(!res.status_reason.contains(&token));

        // Recovery remains possible once agent returns to Normal
        transport.set_mode(FaultMode::Normal {
            agent_running: true,
            engine_available: true,
        });
        let recovered = client.poll_health();
        assert_eq!(recovered.state, TrayHealthState::Online);
        assert!(client.has_active_session());
    }
}

#[test]
fn timeout_marks_stale_and_agent_running_false_discards_session() {
    let token = "4".repeat(64);
    let transport = FaultTransport::new(&token, FaultMode::TimeoutOnHealth);
    let mut client = IpcHealthClient::new(transport.clone());

    let stale = client.poll_health();
    assert_eq!(stale.state, TrayHealthState::Stale);
    assert!(!client.has_active_session());
    assert!(stale.health.is_none());

    transport.set_mode(FaultMode::Normal {
        agent_running: false,
        engine_available: false,
    });
    let offline = client.poll_health();
    assert_eq!(offline.state, TrayHealthState::Offline);
    assert!(!client.has_active_session());
}

#[test]
fn connection_refused_saturation_uses_bounded_backoff_and_sanitized_reason() {
    let token = "5".repeat(64);
    let transport = FaultTransport::new(&token, FaultMode::ConnectionRefused);
    let mut client = IpcHealthClient::with_timeout_and_backoff(
        transport.clone(),
        TRAY_HEALTH_TIMEOUT,
        Duration::from_secs(5),
        Duration::from_secs(60),
    );

    let t0 = Instant::now();
    // 1st failure (allows immediate retry)
    let r1 = client.poll_health_at(t0);
    assert_eq!(r1.state, TrayHealthState::Offline);
    assert_eq!(r1.status_reason, "Agent socket unavailable");
    assert_eq!(transport.connect_attempts(), 1);

    // 2nd failure -> engages 5s backoff
    let _ = client.poll_health_at(t0 + Duration::from_secs(1));
    assert_eq!(transport.connect_attempts(), 2);

    // Tight loop attempt at t+2s -> skipped by backoff
    let _ = client.poll_health_at(t0 + Duration::from_secs(2));
    assert_eq!(transport.connect_attempts(), 2);
}
