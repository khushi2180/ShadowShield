use shadowshield_desktop_lib::ipc::client::{
    ConnectError, IpcHealthClient, IpcStream, IpcTransport, TRAY_HEALTH_TIMEOUT,
};
use shadowshield_desktop_lib::ipc::protocol::{
    IpcRequest, TokenSecret, TrayHealthState, PROTOCOL_VERSION, UNMONITORED_LABEL,
};
use shadowshield_desktop_lib::lifecycle::{
    CloseAction, ExitAction, QuitAction, ShowAction, TrayLifecycleState,
};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[test]
fn tray_initialization_is_idempotent_no_duplicate_tray() {
    let lifecycle = TrayLifecycleState::new(true);
    assert!(!lifecycle.is_tray_initialized());
    assert!(lifecycle.mark_tray_initialized());
    assert!(lifecycle.is_tray_initialized());
    assert!(!lifecycle.mark_tray_initialized());
}

#[test]
fn close_window_persists_tray_and_show_status_reopens() {
    let lifecycle = TrayLifecycleState::new(true);
    assert!(lifecycle.is_window_visible());

    assert_eq!(lifecycle.on_close_requested(), CloseAction::HideToTray);
    assert!(!lifecycle.is_window_visible());
    assert_eq!(lifecycle.on_exit_requested(), ExitAction::PreventExit);

    assert_eq!(lifecycle.on_show_status(), ShowAction::ShowAndFocus);
    assert!(lifecycle.is_window_visible());
    assert_eq!(lifecycle.on_exit_requested(), ExitAction::PreventExit);
}

#[test]
fn quit_allows_clean_exit_and_window_close() {
    let lifecycle = TrayLifecycleState::new(true);
    assert_eq!(lifecycle.on_quit_requested(), QuitAction::ExitCleanly);
    assert!(lifecycle.is_quitting());
    assert_eq!(lifecycle.on_exit_requested(), ExitAction::AllowExit);
    assert_eq!(lifecycle.on_close_requested(), CloseAction::AllowClose);
}

struct MockScriptedTransport {
    token_reads: AtomicUsize,
    connect_attempts: AtomicUsize,
    available: Mutex<bool>,
    token: Mutex<Option<String>>,
    engine_available: Mutex<bool>,
}

impl MockScriptedTransport {
    fn offline() -> Self {
        Self {
            token_reads: AtomicUsize::new(0),
            connect_attempts: AtomicUsize::new(0),
            available: Mutex::new(false),
            token: Mutex::new(None),
            engine_available: Mutex::new(true),
        }
    }

    fn set_online(&self, token: &str, engine_available: bool) {
        *self.token.lock().unwrap() = Some(token.to_string());
        *self.engine_available.lock().unwrap() = engine_available;
        *self.available.lock().unwrap() = true;
    }

    fn token_read_count(&self) -> usize {
        self.token_reads.load(Ordering::SeqCst)
    }

    fn connect_attempt_count(&self) -> usize {
        self.connect_attempts.load(Ordering::SeqCst)
    }
}

struct ScriptedStream {
    expected_token: String,
    engine_available: bool,
    incoming: Vec<u8>,
    outgoing: VecDeque<u8>,
}

impl Read for ScriptedStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.outgoing.is_empty() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "eof"));
        }
        let n = buf.len().min(self.outgoing.len());
        for slot in buf.iter_mut().take(n) {
            *slot = self.outgoing.pop_front().unwrap();
        }
        Ok(n)
    }
}

impl Write for ScriptedStream {
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
            let resp = match req.msg_type.as_str() {
                "Authenticate" => {
                    let tok = req.payload["token"].as_str().unwrap_or("");
                    if tok == self.expected_token {
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
                    }
                }
                "Hello" => serde_json::json!({
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": req.request_id,
                    "type": "HelloResponse",
                    "payload": {
                        "agent_version": "0.1.0-test",
                        "protocol_version": PROTOCOL_VERSION,
                        "compatible": true
                    }
                }),
                "Health" => serde_json::json!({
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": req.request_id,
                    "type": "HealthResponse",
                    "payload": {
                        "agent_running": true,
                        "inspection_engine_available": self.engine_available,
                        "protocol_version": PROTOCOL_VERSION
                    }
                }),
                _ => unreachable!(),
            };
            let bytes = serde_json::to_vec(&resp).unwrap();
            self.outgoing.extend((bytes.len() as u32).to_le_bytes());
            self.outgoing.extend(bytes);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl IpcStream for ScriptedStream {
    fn set_timeout(&mut self, _timeout: Duration) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct SharedMockTransport(Arc<MockScriptedTransport>);

impl IpcTransport for SharedMockTransport {
    fn read_token(&self) -> Result<TokenSecret, ConnectError> {
        self.0.token_reads.fetch_add(1, Ordering::SeqCst);
        match self.0.token.lock().unwrap().as_ref() {
            Some(tok) => Ok(TokenSecret::new(tok.clone())),
            None => Err(ConnectError::TokenMissing),
        }
    }

    fn connect(&self, _timeout: Duration) -> Result<Box<dyn IpcStream>, ConnectError> {
        self.0.connect_attempts.fetch_add(1, Ordering::SeqCst);
        if !*self.0.available.lock().unwrap() {
            return Err(ConnectError::SocketUnavailable);
        }
        let expected_token = self.0.token.lock().unwrap().clone().unwrap_or_default();
        let engine_available = *self.0.engine_available.lock().unwrap();
        Ok(Box::new(ScriptedStream {
            expected_token,
            engine_available,
            incoming: Vec::new(),
            outgoing: VecDeque::new(),
        }))
    }
}

#[test]
fn agent_independent_startup_returns_offline_and_unmonitored_labels() {
    let transport = SharedMockTransport(Arc::new(MockScriptedTransport::offline()));
    let mut client = IpcHealthClient::new(transport);
    let status = client.poll_health();

    assert_eq!(status.state, TrayHealthState::Offline);
    assert!(status.health.is_none());
    assert_eq!(status.browser_protection, UNMONITORED_LABEL);
    assert_eq!(status.ide_protection, UNMONITORED_LABEL);
    assert!(!client.has_active_session());
}

#[test]
fn reconnect_backoff_is_bounded_and_prevents_tight_loop() {
    let inner = Arc::new(MockScriptedTransport::offline());
    let mut client = IpcHealthClient::with_timeout_and_backoff(
        SharedMockTransport(Arc::clone(&inner)),
        TRAY_HEALTH_TIMEOUT,
        Duration::from_secs(5),
        Duration::from_secs(60),
    );

    let t0 = Instant::now();
    // Failure 1 at t=0 -> allows immediate retry (for agent restart / token rotation)
    let s1 = client.poll_health_at(t0);
    assert_eq!(s1.state, TrayHealthState::Offline);
    assert_eq!(inner.token_read_count(), 1);
    assert_eq!(client.consecutive_failures(), 1);

    // Failure 2 at t+1s -> 5s delay -> next retry at t+6s
    let _ = client.poll_health_at(t0 + Duration::from_secs(1));
    assert_eq!(inner.token_read_count(), 2);
    assert_eq!(client.consecutive_failures(), 2);

    // Poll at t+5s -> skipped by backoff
    let s_skip = client.poll_health_at(t0 + Duration::from_secs(5));
    assert_eq!(s_skip.state, TrayHealthState::Offline);
    assert_eq!(inner.token_read_count(), 2);

    // Failure 3 at t+6s -> 10s delay -> t+16s
    let _ = client.poll_health_at(t0 + Duration::from_secs(6));
    assert_eq!(inner.token_read_count(), 3);
    assert_eq!(client.consecutive_failures(), 3);

    // Poll at t+15s -> still skipped
    let _ = client.poll_health_at(t0 + Duration::from_secs(15));
    assert_eq!(inner.token_read_count(), 3);

    // Failure 4 at t+16s -> 20s delay -> t+36s
    let _ = client.poll_health_at(t0 + Duration::from_secs(16));
    assert_eq!(inner.token_read_count(), 4);

    // Failure 5 at t+36s -> 40s delay -> t+76s
    let _ = client.poll_health_at(t0 + Duration::from_secs(36));
    assert_eq!(inner.token_read_count(), 5);

    // Failure 6 at t+76s -> capped at 60s delay -> t+136s
    let _ = client.poll_health_at(t0 + Duration::from_secs(76));
    assert_eq!(inner.token_read_count(), 6);

    // At t+135s still skipped, at t+136s allowed (proving 60s cap)
    let _ = client.poll_health_at(t0 + Duration::from_secs(135));
    assert_eq!(inner.token_read_count(), 6);
    let _ = client.poll_health_at(t0 + Duration::from_secs(136));
    assert_eq!(inner.token_read_count(), 7);
}

#[test]
fn reconnect_recovers_rereads_token_and_restores_polling() {
    let inner = Arc::new(MockScriptedTransport::offline());
    let mut client = IpcHealthClient::with_timeout_and_backoff(
        SharedMockTransport(Arc::clone(&inner)),
        TRAY_HEALTH_TIMEOUT,
        Duration::from_secs(5),
        Duration::from_secs(60),
    );

    let t0 = Instant::now();
    assert_eq!(client.poll_health_at(t0).state, TrayHealthState::Offline);
    assert_eq!(client.consecutive_failures(), 1);

    // Agent starts with neutral placeholder token
    let rotated_token = "a".repeat(64);
    inner.set_online(&rotated_token, true);

    let recovered = client.poll_health_at(t0 + Duration::from_secs(5));
    assert_eq!(recovered.state, TrayHealthState::Online);
    assert_eq!(client.consecutive_failures(), 0);
    assert!(client.has_active_session());
    assert_eq!(inner.token_read_count(), 2);
    assert_eq!(inner.connect_attempt_count(), 1);
    assert_eq!(recovered.browser_protection, UNMONITORED_LABEL);
    assert_eq!(recovered.ide_protection, UNMONITORED_LABEL);
    assert!(!recovered.status_reason.contains(&rotated_token));

    // Subsequent poll reuses active session without reconnecting
    let next = client.poll_health_at(t0 + Duration::from_secs(10));
    assert_eq!(next.state, TrayHealthState::Online);
    assert_eq!(inner.connect_attempt_count(), 1);

    // Clean shutdown drops session
    client.shutdown();
    assert!(!client.has_active_session());
}

#[test]
fn degraded_state_preserves_session_and_resets_backoff() {
    let inner = Arc::new(MockScriptedTransport::offline());
    inner.set_online(&"b".repeat(64), false);

    let mut client = IpcHealthClient::new(SharedMockTransport(inner));
    let status = client.poll_health();

    assert_eq!(status.state, TrayHealthState::Degraded);
    assert_eq!(client.consecutive_failures(), 0);
    assert!(client.has_active_session());
    assert_eq!(status.browser_protection, UNMONITORED_LABEL);
    assert_eq!(status.ide_protection, UNMONITORED_LABEL);
}
