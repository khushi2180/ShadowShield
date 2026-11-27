use shadowshield_desktop_lib::ipc::client::{
    read_token_from_path, ConnectError, IpcHealthClient, IpcPaths, IpcStream, IpcTransport,
    TRAY_HEALTH_TIMEOUT, TRAY_POLL_INTERVAL,
};
use shadowshield_desktop_lib::ipc::framing::{
    read_frame, write_frame, FramingError, MAX_FRAME_LENGTH,
};
use shadowshield_desktop_lib::ipc::protocol::{
    IpcRequest, TokenSecret, TrayHealthState, PROTOCOL_VERSION, UNMONITORED_LABEL,
};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
enum ServerBehavior {
    Normal {
        agent_running: bool,
        engine_available: bool,
    },
    RejectAuth,
    ProtocolMismatchInHello,
    IncompatibleHello,
    MalformedHealthPayload,
    UnexpectedHealthType,
    OversizedHealthResponse,
    TimeoutOnHealth,
    DropConnectionOnHealth,
}

struct MockStreamState {
    incoming_buffer: Vec<u8>,
    outgoing_queue: VecDeque<u8>,
    authenticated: bool,
    hello_done: bool,
    observed_types: Vec<String>,
    observed_tokens: Vec<String>,
    expected_token: String,
    behavior: ServerBehavior,
    fail_with_timeout: bool,
}

struct MockIpcStream {
    state: Arc<Mutex<MockStreamState>>,
}

impl Read for MockIpcStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut st = self.state.lock().unwrap();
        if st.fail_with_timeout {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "simulated timeout"));
        }
        if st.outgoing_queue.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed",
            ));
        }
        let n = buf.len().min(st.outgoing_queue.len());
        for slot in buf.iter_mut().take(n) {
            *slot = st.outgoing_queue.pop_front().unwrap();
        }
        Ok(n)
    }
}

impl Write for MockIpcStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut st = self.state.lock().unwrap();
        st.incoming_buffer.extend_from_slice(buf);

        while st.incoming_buffer.len() >= 4 {
            let len = u32::from_le_bytes([
                st.incoming_buffer[0],
                st.incoming_buffer[1],
                st.incoming_buffer[2],
                st.incoming_buffer[3],
            ]) as usize;
            if st.incoming_buffer.len() < 4 + len {
                break;
            }
            let payload: Vec<u8> = st.incoming_buffer.drain(..4 + len).skip(4).collect();
            let req: IpcRequest = serde_json::from_slice(&payload).unwrap();
            st.observed_types.push(req.msg_type.clone());
            handle_mock_server_request(&mut st, req);
        }

        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl IpcStream for MockIpcStream {
    fn set_timeout(&mut self, _timeout: Duration) -> io::Result<()> {
        Ok(())
    }
}

fn queue_response(st: &mut MockStreamState, value: &serde_json::Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    let len = bytes.len() as u32;
    st.outgoing_queue.extend(len.to_le_bytes());
    st.outgoing_queue.extend(bytes);
}

fn handle_mock_server_request(st: &mut MockStreamState, req: IpcRequest) {
    match req.msg_type.as_str() {
        "Authenticate" => {
            let token = req.payload["token"].as_str().unwrap_or("").to_string();
            st.observed_tokens.push(token.clone());
            if matches!(st.behavior, ServerBehavior::RejectAuth) || token != st.expected_token {
                queue_response(
                    st,
                    &serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "Error",
                        "payload": { "code": "unauthorized", "message": "Invalid authentication token" }
                    }),
                );
                return;
            }
            st.authenticated = true;
            queue_response(
                st,
                &serde_json::json!({
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": req.request_id,
                    "type": "AuthenticateResponse",
                    "payload": { "authenticated": true }
                }),
            );
        }
        "Hello" => {
            if !st.authenticated {
                queue_response(
                    st,
                    &serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "Error",
                        "payload": { "code": "unauthorized", "message": "Authentication required" }
                    }),
                );
                return;
            }
            match st.behavior {
                ServerBehavior::ProtocolMismatchInHello => {
                    queue_response(
                        st,
                        &serde_json::json!({
                            "protocol_version": 99,
                            "request_id": req.request_id,
                            "type": "HelloResponse",
                            "payload": { "agent_version": "0.1.0-dev", "protocol_version": 99, "compatible": false }
                        }),
                    );
                }
                ServerBehavior::IncompatibleHello => {
                    queue_response(
                        st,
                        &serde_json::json!({
                            "protocol_version": PROTOCOL_VERSION,
                            "request_id": req.request_id,
                            "type": "HelloResponse",
                            "payload": { "agent_version": "0.1.0-dev", "protocol_version": PROTOCOL_VERSION, "compatible": false }
                        }),
                    );
                }
                _ => {
                    st.hello_done = true;
                    queue_response(
                        st,
                        &serde_json::json!({
                            "protocol_version": PROTOCOL_VERSION,
                            "request_id": req.request_id,
                            "type": "HelloResponse",
                            "payload": { "agent_version": "0.1.0-dev", "protocol_version": PROTOCOL_VERSION, "compatible": true }
                        }),
                    );
                }
            }
        }
        "Health" => {
            if !st.authenticated || !st.hello_done {
                queue_response(
                    st,
                    &serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "request_id": req.request_id,
                        "type": "Error",
                        "payload": { "code": "unauthorized", "message": "Hello required" }
                    }),
                );
                return;
            }
            match st.behavior {
                ServerBehavior::Normal {
                    agent_running,
                    engine_available,
                } => {
                    queue_response(
                        st,
                        &serde_json::json!({
                            "protocol_version": PROTOCOL_VERSION,
                            "request_id": req.request_id,
                            "type": "HealthResponse",
                            "payload": {
                                "agent_running": agent_running,
                                "inspection_engine_available": engine_available,
                                "protocol_version": PROTOCOL_VERSION
                            }
                        }),
                    );
                }
                ServerBehavior::MalformedHealthPayload => {
                    let bad = b"not-valid-json";
                    st.outgoing_queue.extend((bad.len() as u32).to_le_bytes());
                    st.outgoing_queue.extend(bad);
                }
                ServerBehavior::UnexpectedHealthType => {
                    queue_response(
                        st,
                        &serde_json::json!({
                            "protocol_version": PROTOCOL_VERSION,
                            "request_id": req.request_id,
                            "type": "InspectResponse",
                            "payload": {}
                        }),
                    );
                }
                ServerBehavior::OversizedHealthResponse => {
                    let oversized = MAX_FRAME_LENGTH + 1;
                    st.outgoing_queue.extend(oversized.to_le_bytes());
                }
                ServerBehavior::TimeoutOnHealth => {
                    st.fail_with_timeout = true;
                }
                ServerBehavior::DropConnectionOnHealth => {
                    st.outgoing_queue.clear();
                }
                _ => {}
            }
        }
        _ => {}
    }
}

struct MockTransportControl {
    token_result: Result<String, ConnectError>,
    socket_available: bool,
    server_expected_token: String,
    behavior: ServerBehavior,
    last_stream_state: Option<Arc<Mutex<MockStreamState>>>,
}

#[derive(Clone)]
struct MockTransport {
    control: Arc<Mutex<MockTransportControl>>,
}

impl MockTransport {
    fn new(token: &str, behavior: ServerBehavior) -> Self {
        Self {
            control: Arc::new(Mutex::new(MockTransportControl {
                token_result: Ok(token.to_string()),
                socket_available: true,
                server_expected_token: token.to_string(),
                behavior,
                last_stream_state: None,
            })),
        }
    }
}

impl IpcTransport for MockTransport {
    fn read_token(&self) -> Result<TokenSecret, ConnectError> {
        let ctrl = self.control.lock().unwrap();
        ctrl.token_result.clone().map(TokenSecret::new)
    }

    fn connect(&self, _timeout: Duration) -> Result<Box<dyn IpcStream>, ConnectError> {
        let mut ctrl = self.control.lock().unwrap();
        if !ctrl.socket_available {
            return Err(ConnectError::SocketUnavailable);
        }
        let st = Arc::new(Mutex::new(MockStreamState {
            incoming_buffer: Vec::new(),
            outgoing_queue: VecDeque::new(),
            authenticated: false,
            hello_done: false,
            observed_types: Vec::new(),
            observed_tokens: Vec::new(),
            expected_token: ctrl.server_expected_token.clone(),
            behavior: ctrl.behavior.clone(),
            fail_with_timeout: false,
        }));
        ctrl.last_stream_state = Some(st.clone());
        Ok(Box::new(MockIpcStream { state: st }))
    }
}

#[test]
fn test_framing_encode_decode_and_oversized_rejection() {
    let mut wire = Vec::new();
    let payload = br#"{"protocol_version":1,"request_id":"r1","type":"Health","payload":{}}"#;
    write_frame(&mut wire, payload).expect("write_frame");

    assert_eq!(&wire[..4], &(payload.len() as u32).to_le_bytes());
    let mut cursor = Cursor::new(wire);
    let decoded = read_frame(&mut cursor).expect("read_frame");
    assert_eq!(decoded, payload);

    // Oversized header (> 10 MiB) must be rejected before payload allocation
    let oversized_len = MAX_FRAME_LENGTH + 1;
    let mut bad_cursor = Cursor::new(oversized_len.to_le_bytes().to_vec());
    match read_frame(&mut bad_cursor) {
        Err(FramingError::MessageTooLarge(n)) => assert_eq!(n, oversized_len),
        other => panic!("Expected MessageTooLarge, got {:?}", other),
    }
}

#[test]
fn test_contract_constants_and_paths() {
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(MAX_FRAME_LENGTH, 10_485_760);
    assert_eq!(TRAY_HEALTH_TIMEOUT, Duration::from_secs(3));
    assert_eq!(TRAY_POLL_INTERVAL, Duration::from_secs(5));

    let paths = IpcPaths::from_runtime_dir(PathBuf::from("/tmp/ss-test-run"));
    assert_eq!(paths.socket_path, PathBuf::from("/tmp/ss-test-run/agent.sock"));
    assert_eq!(paths.token_path, PathBuf::from("/tmp/ss-test-run/auth.token"));
}

#[test]
fn test_authenticate_hello_health_ordering_and_valid_response() {
    let transport = MockTransport::new(
        &"a".repeat(64),
        ServerBehavior::Normal {
            agent_running: true,
            engine_available: true,
        },
    );
    let mut client = IpcHealthClient::new(transport.clone());

    let status = client.poll_health();
    assert_eq!(status.state, TrayHealthState::Online);
    assert_eq!(status.browser_protection, UNMONITORED_LABEL);
    assert_eq!(status.ide_protection, UNMONITORED_LABEL);
    assert_eq!(status.agent_version.as_deref(), Some("0.1.0-dev"));
    let health = status.health.expect("health payload");
    assert!(health.agent_running);
    assert!(health.inspection_engine_available);
    assert_eq!(health.protocol_version, 1);

    let st = transport
        .control
        .lock()
        .unwrap()
        .last_stream_state
        .clone()
        .unwrap();
    let observed = st.lock().unwrap().observed_types.clone();
    assert_eq!(observed, vec!["Authenticate", "Hello", "Health"]);
}

#[test]
fn test_degraded_and_agent_not_running_states() {
    let degraded_transport = MockTransport::new(
        &"b".repeat(64),
        ServerBehavior::Normal {
            agent_running: true,
            engine_available: false,
        },
    );
    let mut degraded_client = IpcHealthClient::new(degraded_transport);
    let degraded = degraded_client.poll_health();
    assert_eq!(degraded.state, TrayHealthState::Degraded);
    assert_eq!(degraded.browser_protection, UNMONITORED_LABEL);
    assert_eq!(degraded.ide_protection, UNMONITORED_LABEL);

    let down_transport = MockTransport::new(
        &"b".repeat(64),
        ServerBehavior::Normal {
            agent_running: false,
            engine_available: false,
        },
    );
    let mut down_client = IpcHealthClient::new(down_transport);
    let down = down_client.poll_health();
    assert_eq!(down.state, TrayHealthState::Offline);
}

#[test]
fn test_error_conditions_and_sanitized_failures() {
    let cases = [
        ("malformed", ServerBehavior::MalformedHealthPayload),
        ("unexpected_type", ServerBehavior::UnexpectedHealthType),
        ("oversized", ServerBehavior::OversizedHealthResponse),
        ("proto_mismatch", ServerBehavior::ProtocolMismatchInHello),
        ("incompatible_hello", ServerBehavior::IncompatibleHello),
        ("auth_reject", ServerBehavior::RejectAuth),
    ];

    for (name, behavior) in cases {
        let transport = MockTransport::new(&"c".repeat(64), behavior);
        let mut client = IpcHealthClient::new(transport);
        let status = client.poll_health();
        assert_eq!(status.state, TrayHealthState::Offline, "case {}", name);
        assert!(status.health.is_none(), "case {}", name);
        assert_eq!(status.browser_protection, UNMONITORED_LABEL);
        assert_eq!(status.ide_protection, UNMONITORED_LABEL);
        assert!(!client.has_active_session(), "case {}", name);
    }
}

#[test]
fn test_missing_token_and_socket_unavailable() {
    let transport_missing = MockTransport::new(&"d".repeat(64), ServerBehavior::RejectAuth);
    transport_missing.control.lock().unwrap().token_result = Err(ConnectError::TokenMissing);
    let mut client = IpcHealthClient::new(transport_missing);
    let status = client.poll_health();
    assert_eq!(status.state, TrayHealthState::Offline);
    assert_eq!(status.status_reason, "Authentication token missing");

    let transport_no_sock = MockTransport::new(&"d".repeat(64), ServerBehavior::RejectAuth);
    transport_no_sock.control.lock().unwrap().socket_available = false;
    let mut client2 = IpcHealthClient::new(transport_no_sock);
    let status2 = client2.poll_health();
    assert_eq!(status2.state, TrayHealthState::Offline);
    assert_eq!(status2.status_reason, "Agent socket unavailable");

    // Verify real filesystem missing-token error handling
    let uniq = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_token = std::env::temp_dir().join(format!("ss-missing-{}.token", uniq));
    let _ = fs::remove_file(&temp_token);
    assert_eq!(read_token_from_path(&temp_token), Err(ConnectError::TokenMissing));
}

#[test]
fn test_three_second_timeout_marks_stale() {
    let transport = MockTransport::new(&"e".repeat(64), ServerBehavior::TimeoutOnHealth);
    let mut client = IpcHealthClient::with_timeout(transport, Duration::from_secs(3));

    let status = client.poll_health();
    assert_eq!(status.state, TrayHealthState::Stale);
    assert!(status.health.is_none());
    assert_eq!(status.browser_protection, UNMONITORED_LABEL);
    assert_eq!(status.ide_protection, UNMONITORED_LABEL);
    assert!(!client.has_active_session());
}

#[test]
fn test_reconnect_and_token_reread_on_agent_restart() {
    let token_v1 = "1".repeat(64);
    let token_v2 = "2".repeat(64);

    let transport = MockTransport::new(
        &token_v1,
        ServerBehavior::Normal {
            agent_running: true,
            engine_available: true,
        },
    );
    let mut client = IpcHealthClient::new(transport.clone());

    // 1. Initial connection succeeds with token_v1
    let s1 = client.poll_health();
    assert_eq!(s1.state, TrayHealthState::Online);
    assert!(client.has_active_session());

    // 2. Simulate agent crash / connection drop on next Health poll
    {
        let st = transport
            .control
            .lock()
            .unwrap()
            .last_stream_state
            .clone()
            .unwrap();
        st.lock().unwrap().behavior = ServerBehavior::DropConnectionOnHealth;
    }
    let s2 = client.poll_health();
    assert_eq!(s2.state, TrayHealthState::Offline);
    assert!(!client.has_active_session());

    // 3. Agent restarts with rotated token_v2; client must re-read auth.token and recover
    {
        let mut ctrl = transport.control.lock().unwrap();
        ctrl.token_result = Ok(token_v2.clone());
        ctrl.server_expected_token = token_v2.clone();
        ctrl.behavior = ServerBehavior::Normal {
            agent_running: true,
            engine_available: true,
        };
    }
    let s3 = client.poll_health();
    assert_eq!(s3.state, TrayHealthState::Online);

    let st_v2 = transport
        .control
        .lock()
        .unwrap()
        .last_stream_state
        .clone()
        .unwrap();
    assert_eq!(st_v2.lock().unwrap().observed_tokens, vec![token_v2]);
}

#[test]
fn test_token_secret_redaction_and_sanitized_boundary() {
    let secret = TokenSecret::new("0123456789abcdef".repeat(4));
    assert_eq!(format!("{:?}", secret), "TokenSecret(<redacted>)");
    assert_eq!(format!("{}", secret), "<redacted>");

    let transport = MockTransport::new(
        secret.expose(),
        ServerBehavior::Normal {
            agent_running: true,
            engine_available: true,
        },
    );
    let mut client = IpcHealthClient::new(transport);
    let status = client.poll_health();
    let json = serde_json::to_string(&status).unwrap();
    assert!(!json.contains(secret.expose()));
    assert!(!json.contains("token"));
}
