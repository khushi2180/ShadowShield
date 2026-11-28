use byteorder::{LittleEndian, WriteBytesExt};
use shadowshield_agent::ipc::framing::{read_message, write_message, MAX_MESSAGE_SIZE};
use shadowshield_agent::ipc::{sys, IpcClient, IpcServer, IpcServerConfig};
use shadowshield_core::Inspector;
use shadowshield_protocol::ipc::{
    HealthRequest, HelloRequest, HelloResponse, InspectResponse, IpcErrorResponse, IpcRequest,
    IpcResponse,
};
use shadowshield_protocol::{AiAccessDecision, AiAccessMode, PolicyAction};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static TEST_COUNTER: AtomicU64 = AtomicU64::new(300);

struct TestDirGuard {
    path: PathBuf,
}

impl TestDirGuard {
    fn new(_test_name: &str) -> Self {
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = PathBuf::from(format!("/tmp/ss-r3-{}-{}", std::process::id(), count));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test dir");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("chmod 0700");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn start_test_server(test_dir: &Path) -> (IpcServer, String, PathBuf) {
    let config = IpcServerConfig {
        runtime_dir: test_dir.to_path_buf(),
        max_clients: 8,
        handshake_timeout: Duration::from_millis(1000),
        idle_timeout: Duration::from_secs(5),
        frame_timeout: Duration::from_millis(500),
        shutdown_grace_period: Duration::from_secs(2),
    };
    let server = IpcServer::new(config).expect("initialize IpcServer");
    let token = server.token().to_string();
    let socket_path = server.socket_path();
    (server, token, socket_path)
}

fn start_custom_test_server(
    _test_dir: &Path,
    config: IpcServerConfig,
) -> (IpcServer, String, PathBuf) {
    let server = IpcServer::new(config).expect("initialize IpcServer");
    let token = server.token().to_string();
    let socket_path = server.socket_path();
    (server, token, socket_path)
}

fn authenticate_and_hello(stream: &mut UnixStream, token: &str) {
    let auth_req = IpcRequest {
        protocol_version: 1,
        request_id: "auth-1".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };
    write_message(stream, &auth_req).expect("write auth");
    let auth_resp: IpcResponse = read_message(stream).expect("read auth resp");
    assert_eq!(auth_resp.msg_type, "AuthenticateResponse");

    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: "hello-1".to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::to_value(HelloRequest {
            extension_version: "1.0.0".to_string(),
            protocol_version: 1,
        })
        .unwrap(),
    };
    write_message(stream, &hello_req).expect("write hello");
    let hello_resp: IpcResponse = read_message(stream).expect("read hello resp");
    assert_eq!(hello_resp.msg_type, "HelloResponse");
}

// -----------------------------------------------------------------------------
// Test 1: Client sends length header and stalls (aborts in frame_timeout)
// -----------------------------------------------------------------------------
#[test]
fn test_01_client_sends_length_header_and_stalls() {
    let test_dir = TestDirGuard::new("t01_header_stall");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        frame_timeout: Duration::from_millis(200),
        idle_timeout: Duration::from_secs(5),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Send a 4-byte length header claiming 100 bytes, then stall without sending payload
    let mut header = [0u8; 4];
    (&mut header[..]).write_u32::<LittleEndian>(100).unwrap();
    stream.write_all(&header).expect("write header");
    stream.flush().expect("flush");

    // Sleep past the 200ms frame deadline
    thread::sleep(Duration::from_millis(350));

    // Server should have aborted and closed the connection
    let mut buf = [0u8; 16];
    let res = stream.read(&mut buf);
    match res {
        Ok(0) => {}  // EOF - socket closed cleanly
        Err(_) => {} // Connection reset / broken pipe
        Ok(n) => panic!("Expected connection to be closed, but read {} bytes", n),
    }

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 2: Client slowly trickles payload bytes (aborts at deadline)
// -----------------------------------------------------------------------------
#[test]
fn test_02_client_slowly_trickles_payload_bytes() {
    let test_dir = TestDirGuard::new("t02_trickle_payload");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        frame_timeout: Duration::from_millis(200),
        idle_timeout: Duration::from_secs(5),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Send length header claiming 200 bytes
    let mut header = [0u8; 4];
    (&mut header[..]).write_u32::<LittleEndian>(200).unwrap();
    stream.write_all(&header).expect("write header");

    // Trickle 1 byte every 30ms. At 200ms (~7 bytes in), the absolute frame deadline expires
    let start = Instant::now();
    let mut connection_closed = false;
    for _ in 0..15 {
        thread::sleep(Duration::from_millis(30));
        if stream.write_all(b"X").is_err() || stream.flush().is_err() {
            connection_closed = true;
            break;
        }
    }

    if !connection_closed {
        let mut buf = [0u8; 16];
        let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
        if let Ok(0) = stream.read(&mut buf) {
            connection_closed = true;
        }
    }

    assert!(
        connection_closed,
        "Server must abort trickling client at absolute frame deadline"
    );
    assert!(
        start.elapsed() >= Duration::from_millis(150),
        "Must enforce frame deadline duration"
    );

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 3: Total frame deadline expires despite intermittent progress
// -----------------------------------------------------------------------------
#[test]
fn test_03_total_frame_deadline_expires_despite_intermittent_progress() {
    let test_dir = TestDirGuard::new("t03_intermittent_progress");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        frame_timeout: Duration::from_millis(250),
        idle_timeout: Duration::from_secs(5),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Write 4-byte header claiming 100 bytes
    let mut header = [0u8; 4];
    (&mut header[..]).write_u32::<LittleEndian>(100).unwrap();
    stream.write_all(&header).expect("write header");

    // Send 2 bytes every 25ms. The socket never idles for more than 25ms, but
    // absolute frame deadline is 250ms. By 350ms, the connection must be closed.
    let start = Instant::now();
    let mut closed = false;
    for _ in 0..14 {
        thread::sleep(Duration::from_millis(25));
        if stream.write_all(b"YY").is_err() || stream.flush().is_err() {
            closed = true;
            break;
        }
    }

    if !closed {
        let mut buf = [0u8; 8];
        let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
        if let Ok(0) = stream.read(&mut buf) {
            closed = true;
        }
    }

    assert!(
        closed,
        "Server must close connection after absolute frame deadline despite progress"
    );
    assert!(start.elapsed() >= Duration::from_millis(200));

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 4: Valid fragmented frame completes before deadline
// -----------------------------------------------------------------------------
#[test]
fn test_04_valid_fragmented_frame_completes_before_deadline() {
    let test_dir = TestDirGuard::new("t04_fragmented_frame");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        frame_timeout: Duration::from_millis(500),
        idle_timeout: Duration::from_secs(5),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Construct valid Health request
    let health_req = IpcRequest {
        protocol_version: 1,
        request_id: "health-frag".to_string(),
        msg_type: "Health".to_string(),
        payload: serde_json::to_value(HealthRequest {}).unwrap(),
    };
    let payload_bytes = serde_json::to_vec(&health_req).unwrap();
    let mut full_frame = Vec::new();
    full_frame
        .write_u32::<LittleEndian>(payload_bytes.len() as u32)
        .unwrap();
    full_frame.extend_from_slice(&payload_bytes);

    // Send in chunks of 5 bytes with 20ms delays (total time ~60ms < 500ms deadline)
    for chunk in full_frame.chunks(5) {
        stream.write_all(chunk).expect("write chunk");
        stream.flush().expect("flush");
        thread::sleep(Duration::from_millis(20));
    }

    let resp: IpcResponse = read_message(&mut stream).expect("read response");
    assert_eq!(resp.request_id, "health-frag");
    assert_eq!(resp.msg_type, "HealthResponse");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 5: Coalesced frames remain supported
// -----------------------------------------------------------------------------
#[test]
fn test_05_coalesced_frames_remain_supported() {
    let test_dir = TestDirGuard::new("t05_coalesced_frames");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Prepare two Health requests
    let req1 = IpcRequest {
        protocol_version: 1,
        request_id: "coal-1".to_string(),
        msg_type: "Health".to_string(),
        payload: serde_json::to_value(HealthRequest {}).unwrap(),
    };
    let req2 = IpcRequest {
        protocol_version: 1,
        request_id: "coal-2".to_string(),
        msg_type: "Health".to_string(),
        payload: serde_json::to_value(HealthRequest {}).unwrap(),
    };

    let p1 = serde_json::to_vec(&req1).unwrap();
    let p2 = serde_json::to_vec(&req2).unwrap();

    let mut buffer = Vec::new();
    buffer.write_u32::<LittleEndian>(p1.len() as u32).unwrap();
    buffer.extend_from_slice(&p1);
    buffer.write_u32::<LittleEndian>(p2.len() as u32).unwrap();
    buffer.extend_from_slice(&p2);

    // Send both in a single write
    stream.write_all(&buffer).expect("write coalesced frames");
    stream.flush().expect("flush");

    let resp1: IpcResponse = read_message(&mut stream).expect("read resp1");
    let resp2: IpcResponse = read_message(&mut stream).expect("read resp2");

    assert_eq!(resp1.request_id, "coal-1");
    assert_eq!(resp2.request_id, "coal-2");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 6: Oversized frame (> 10 MiB) rejected before allocation
// -----------------------------------------------------------------------------
#[test]
fn test_06_oversized_frame_rejected_before_allocation() {
    let test_dir = TestDirGuard::new("t06_oversized_frame");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Send frame header indicating 10 MiB + 1 byte (10485761 bytes)
    let oversized_len = MAX_MESSAGE_SIZE + 1;
    let mut header = [0u8; 4];
    (&mut header[..])
        .write_u32::<LittleEndian>(oversized_len)
        .unwrap();
    stream.write_all(&header).expect("write header");
    stream.flush().expect("flush");

    // Server must respond with error frame and close connection
    let err_resp: IpcErrorResponse = read_message(&mut stream).expect("read error response");
    assert_eq!(err_resp.msg_type, "Error");
    let err_payload = err_resp.payload;
    assert_eq!(err_payload.code, "message_too_large");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 7: Client disconnects mid-frame (ConnectionClosed)
// -----------------------------------------------------------------------------
#[test]
fn test_07_client_disconnect_mid_frame() {
    let test_dir = TestDirGuard::new("t07_disconnect_mid_frame");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    {
        let mut stream = UnixStream::connect(&socket_path).expect("connect");
        authenticate_and_hello(&mut stream, &token);

        // Send length header claiming 500 bytes and only 10 bytes of payload
        let mut header = [0u8; 4];
        (&mut header[..]).write_u32::<LittleEndian>(500).unwrap();
        stream.write_all(&header).expect("write header");
        stream
            .write_all(b"0123456789")
            .expect("write partial payload");
        stream.flush().expect("flush");
        // Drop stream abruptly mid-frame
    }

    thread::sleep(Duration::from_millis(50));

    // Server must continue operating normally for subsequent clients
    let mut client2 = IpcClient::connect(&socket_path).expect("connect client 2");
    assert!(client2.authenticate(&token).expect("authenticate"));
    client2.hello("1.0.0", 1).expect("hello");
    let health = client2.health().expect("health");
    assert!(health.agent_running);

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 8: Multiple slow clients cannot exceed connection limit (max_clients)
// -----------------------------------------------------------------------------
#[test]
fn test_08_multiple_slow_clients_cannot_exceed_connection_limit() {
    let test_dir = TestDirGuard::new("t08_max_clients");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        max_clients: 2,
        frame_timeout: Duration::from_millis(300),
        idle_timeout: Duration::from_secs(5),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    // Connect Client 1 and authenticate
    let mut stream1 = UnixStream::connect(&socket_path).expect("connect 1");
    authenticate_and_hello(&mut stream1, &token);

    // Connect Client 2 and authenticate
    let mut stream2 = UnixStream::connect(&socket_path).expect("connect 2");
    authenticate_and_hello(&mut stream2, &token);

    // Now max_clients (2) is reached. Attempt Client 3 connection
    let mut stream3 = UnixStream::connect(&socket_path).expect("connect 3");
    let auth_req = IpcRequest {
        protocol_version: 1,
        request_id: "auth-3".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };
    let _ = write_message(&mut stream3, &auth_req);

    // Stream 3 should be rejected / closed because max_clients was exceeded
    let mut buf = [0u8; 16];
    let res = stream3.read(&mut buf);
    match res {
        Ok(0) | Err(_) => {}
        Ok(_) => panic!("Client 3 should have been rejected immediately"),
    }

    // Drop Client 1 and wait for cleanup
    drop(stream1);
    thread::sleep(Duration::from_millis(50));

    // Now Client 4 can connect successfully
    let mut client4 = IpcClient::connect(&socket_path).expect("connect 4");
    assert!(client4.authenticate(&token).expect("auth 4"));
    client4.hello("1.0.0", 1).expect("hello 4");

    drop(stream2);
    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 9: Shutdown stops new connections
// -----------------------------------------------------------------------------
#[test]
fn test_09_shutdown_stops_new_connections() {
    let test_dir = TestDirGuard::new("t09_shutdown_stops_new");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut client1 = IpcClient::connect(&socket_path).expect("connect 1");
    assert!(client1.authenticate(&token).expect("auth 1"));
    client1.hello("1.0.0", 1).expect("hello 1");

    // Signal shutdown
    shutdown_handle.shutdown();
    thread::sleep(Duration::from_millis(50));

    // New connection attempt should fail or get closed immediately
    let res = UnixStream::connect(&socket_path);
    if let Ok(mut s) = res {
        let auth_req = IpcRequest {
            protocol_version: 1,
            request_id: "auth-shut".to_string(),
            msg_type: "Authenticate".to_string(),
            payload: serde_json::json!({ "token": token }),
        };
        let _ = write_message(&mut s, &auth_req);
        let mut buf = [0u8; 16];
        let read_res = s.read(&mut buf);
        assert!(matches!(read_res, Ok(0) | Err(_)));
    }

    drop(client1);
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 10: In-flight request completes during grace period
// -----------------------------------------------------------------------------
#[test]
fn test_10_in_flight_request_completes_during_grace_period() {
    let test_dir = TestDirGuard::new("t10_inflight_grace_period");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        shutdown_grace_period: Duration::from_millis(1500),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // Trigger shutdown
    shutdown_handle.shutdown();

    // Client sends Inspect request right as shutdown begins
    let inspect_resp = client
        .inspect(
            "VSCode",
            "chatgpt",
            "In-flight inspection text during shutdown",
        )
        .expect("in-flight inspect should complete within grace period");

    assert_eq!(inspect_resp.action, PolicyAction::Allow);

    drop(client);
    let clean = server_handle.join().expect("server join");
    assert!(
        clean,
        "Server should shut down cleanly after in-flight request finishes"
    );
}

// -----------------------------------------------------------------------------
// Test 11: Worker completion is tracked correctly (active_clients_count)
// -----------------------------------------------------------------------------
#[test]
fn test_11_worker_completion_tracked_correctly() {
    let test_dir = TestDirGuard::new("t11_worker_tracking");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();

    assert_eq!(shutdown_handle.active_clients_count(), 0);

    let server_handle = thread::spawn(move || server.run());

    // Connect Client 1
    let mut client1 = IpcClient::connect(&socket_path).expect("connect 1");
    assert!(client1.authenticate(&token).expect("auth 1"));
    client1.hello("1.0.0", 1).expect("hello 1");
    thread::sleep(Duration::from_millis(50));
    assert_eq!(shutdown_handle.active_clients_count(), 1);

    // Connect Client 2
    let mut client2 = IpcClient::connect(&socket_path).expect("connect 2");
    assert!(client2.authenticate(&token).expect("auth 2"));
    client2.hello("1.0.0", 1).expect("hello 2");
    thread::sleep(Duration::from_millis(50));
    assert_eq!(shutdown_handle.active_clients_count(), 2);

    // Disconnect Client 1
    drop(client1);
    thread::sleep(Duration::from_millis(50));
    assert_eq!(shutdown_handle.active_clients_count(), 1);

    // Disconnect Client 2
    drop(client2);
    thread::sleep(Duration::from_millis(50));
    assert_eq!(shutdown_handle.active_clients_count(), 0);

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 12: Grace period expires with a remaining worker (returns clean == false)
// -----------------------------------------------------------------------------
#[test]
fn test_12_grace_period_expires_with_remaining_worker() {
    let test_dir = TestDirGuard::new("t12_grace_period_expires");
    let config = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        shutdown_grace_period: Duration::from_millis(150),
        idle_timeout: Duration::from_millis(400),
        ..IpcServerConfig::default()
    };
    let (server, token, socket_path) = start_custom_test_server(test_dir.path(), config);
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut stream = UnixStream::connect(&socket_path).expect("connect");
    authenticate_and_hello(&mut stream, &token);

    // Trigger shutdown while stream is kept open and idling
    shutdown_handle.shutdown();

    // Server should wait for grace period (150ms) and return clean == false
    let start = Instant::now();
    let clean = server_handle.join().expect("server join");
    assert!(
        !clean,
        "Must return clean == false when worker remains active after grace period"
    );
    assert!(
        start.elapsed() >= Duration::from_millis(140),
        "Must respect grace period duration"
    );

    drop(stream);
}

// -----------------------------------------------------------------------------
// Test 13: Daemon restart after shutdown (stale socket recovery & lock reacquisition)
// -----------------------------------------------------------------------------
#[test]
fn test_13_daemon_restart_after_shutdown() {
    let test_dir = TestDirGuard::new("t13_daemon_restart");

    // Run instance 1
    {
        let (server1, token1, socket_path1) = start_test_server(test_dir.path());
        let shutdown1 = server1.shutdown_handle();
        let handle1 = thread::spawn(move || server1.run());

        let mut client = IpcClient::connect(&socket_path1).expect("connect 1");
        assert!(client.authenticate(&token1).expect("auth 1"));
        client.hello("1.0.0", 1).expect("hello 1");
        drop(client);

        shutdown1.shutdown();
        handle1.join().expect("server 1 join");
    }

    // Run instance 2 in the same directory
    {
        let (server2, token2, socket_path2) = start_test_server(test_dir.path());
        let shutdown2 = server2.shutdown_handle();
        let handle2 = thread::spawn(move || server2.run());

        let mut client = IpcClient::connect(&socket_path2).expect("connect 2");
        assert!(client.authenticate(&token2).expect("auth 2"));
        client.hello("1.0.0", 1).expect("hello 2");
        let health = client.health().expect("health 2");
        assert!(health.agent_running);
        drop(client);

        shutdown2.shutdown();
        handle2.join().expect("server 2 join");
    }
}

// -----------------------------------------------------------------------------
// Test 14: Token rotation after restart (old token rejected)
// -----------------------------------------------------------------------------
#[test]
fn test_14_token_rotation_after_restart() {
    let test_dir = TestDirGuard::new("t14_token_rotation");

    let old_token;
    {
        let (server1, token1, _) = start_test_server(test_dir.path());
        old_token = token1;
        let shutdown1 = server1.shutdown_handle();
        let handle1 = thread::spawn(move || server1.run());
        shutdown1.shutdown();
        handle1.join().expect("server 1 join");
    }

    {
        let (server2, new_token, socket_path) = start_test_server(test_dir.path());
        assert_ne!(
            old_token, new_token,
            "Daemon restart must rotate auth token"
        );

        let shutdown2 = server2.shutdown_handle();
        let handle2 = thread::spawn(move || server2.run());

        // Connect with old token: must be rejected
        let mut client_old = IpcClient::connect(&socket_path).expect("connect old");
        let auth_res = client_old.authenticate(&old_token);
        assert!(
            auth_res.is_err() || !auth_res.unwrap(),
            "Old token must be rejected"
        );
        drop(client_old);

        // Connect with new token: must be accepted
        let mut client_new = IpcClient::connect(&socket_path).expect("connect new");
        assert!(client_new.authenticate(&new_token).expect("auth new"));
        client_new.hello("1.0.0", 1).expect("hello new");
        drop(client_new);

        shutdown2.shutdown();
        handle2.join().expect("server 2 join");
    }
}

// -----------------------------------------------------------------------------
// Test 15: SIGTERM triggers graceful shutdown (subprocess test sending kill -15)
// -----------------------------------------------------------------------------
#[test]
fn test_15_sigterm_triggers_graceful_shutdown() {
    let test_dir = TestDirGuard::new("t15_sigterm");
    let bin_path = env!("CARGO_BIN_EXE_shadowshield-agent");

    let mut cmd = std::process::Command::new(bin_path);
    cmd.env("SHADOWSHIELD_RUNTIME_DIR", test_dir.path());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().expect("spawn shadowshield-agent");
    let pid = child.id() as i32;

    let socket_path = test_dir.path().join("agent.sock");
    let token_path = test_dir.path().join("auth.token");

    // Wait for daemon to initialize
    let start = Instant::now();
    while (!socket_path.exists() || !token_path.exists())
        && start.elapsed() < Duration::from_secs(3)
    {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(socket_path.exists(), "socket must exist");
    assert!(token_path.exists(), "token must exist");

    // Verify operational via IPC client
    let token = fs::read_to_string(&token_path).expect("read token");
    let mut client = IpcClient::connect(&socket_path).expect("connect client");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");
    let health = client.health().expect("health");
    assert!(health.agent_running);
    drop(client);

    // Send SIGTERM (15)
    sys::send_signal(pid, sys::SIGTERM).expect("send SIGTERM");

    // Child must exit cleanly with code 0
    let status = child.wait().expect("child wait");
    assert!(
        status.success(),
        "Daemon must terminate cleanly with exit code 0 on SIGTERM"
    );

    // Socket and token files must be cleanly unlinked
    assert!(
        !socket_path.exists(),
        "Socket file must be unlinked on shutdown"
    );
    assert!(
        !token_path.exists(),
        "Token file must be unlinked on shutdown"
    );
}

// -----------------------------------------------------------------------------
// Test 16: SIGINT triggers graceful shutdown (subprocess test sending kill -2)
// -----------------------------------------------------------------------------
#[test]
fn test_16_sigint_triggers_graceful_shutdown() {
    let test_dir = TestDirGuard::new("t16_sigint");
    let bin_path = env!("CARGO_BIN_EXE_shadowshield-agent");

    let mut cmd = std::process::Command::new(bin_path);
    cmd.env("SHADOWSHIELD_RUNTIME_DIR", test_dir.path());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().expect("spawn shadowshield-agent");
    let pid = child.id() as i32;

    let socket_path = test_dir.path().join("agent.sock");
    let token_path = test_dir.path().join("auth.token");

    // Wait for daemon to initialize
    let start = Instant::now();
    while (!socket_path.exists() || !token_path.exists())
        && start.elapsed() < Duration::from_secs(3)
    {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(socket_path.exists(), "socket must exist");
    assert!(token_path.exists(), "token must exist");

    // Verify operational via IPC client
    let token = fs::read_to_string(&token_path).expect("read token");
    let mut client = IpcClient::connect(&socket_path).expect("connect client");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");
    let health = client.health().expect("health");
    assert!(health.agent_running);
    drop(client);

    // Send SIGINT (2)
    sys::send_signal(pid, sys::SIGINT).expect("send SIGINT");

    // Child must exit cleanly with code 0
    let status = child.wait().expect("child wait");
    assert!(
        status.success(),
        "Daemon must terminate cleanly with exit code 0 on SIGINT"
    );

    // Socket and token files must be cleanly unlinked
    assert!(
        !socket_path.exists(),
        "Socket file must be unlinked on shutdown"
    );
    assert!(
        !token_path.exists(),
        "Token file must be unlinked on shutdown"
    );
}

// -----------------------------------------------------------------------------
// Test 17: Existing Health client remains compatible (Authenticate -> Hello -> Health)
// -----------------------------------------------------------------------------
#[test]
fn test_17_existing_health_client_remains_compatible() {
    let test_dir = TestDirGuard::new("t17_health_compatibility");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut client = IpcClient::connect(&socket_path).expect("connect client");
    assert!(client.authenticate(&token).expect("authenticate"));

    let hello = client.hello("0.1.0", 1).expect("hello");
    assert!(hello.compatible);
    assert_eq!(hello.protocol_version, 1);

    let health = client.health().expect("health");
    assert!(health.agent_running);
    assert!(health.inspection_engine_available);
    assert_eq!(health.protocol_version, 1);

    drop(client);
    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 18: Existing Inspect and EvaluateAiAccess remain compatible
// -----------------------------------------------------------------------------
#[test]
fn test_18_existing_inspect_and_eval_ai_access_compatible() {
    let test_dir = TestDirGuard::new("t18_inspect_eval_compat");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut client = IpcClient::connect(&socket_path).expect("connect client");
    assert!(client.authenticate(&token).expect("authenticate"));
    client.hello("0.1.0", 1).expect("hello");

    // 1. EvaluateAiAccess
    let eval_resp = client
        .evaluate_ai_access("chatgpt", AiAccessMode::Discovery)
        .expect("evaluate ai access");
    assert_eq!(eval_resp.service_id, "chatgpt");
    assert_eq!(eval_resp.decision, AiAccessDecision::Allow);

    // 2. Safe Inspect
    let safe_resp = client
        .inspect("VSCode", "chatgpt", "This is harmless plain text.")
        .expect("inspect safe");
    assert_eq!(safe_resp.action, PolicyAction::Allow);
    assert_eq!(safe_resp.detections_count, 0);

    // 3. Sensitive Inspect
    let sens_resp = client
        .inspect("VSCode", "chatgpt", "4111 1111 1111 1111")
        .expect("inspect sens");
    assert_eq!(sens_resp.action, PolicyAction::Redact);
    assert!(sens_resp.detections_count > 0);
    assert_eq!(
        sens_resp.sanitized_content,
        Some("[REDACTED:PAYMENT_CARD_NUMBER]".to_string())
    );

    drop(client);
    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 19: No prompt or token logging during operations
// -----------------------------------------------------------------------------
#[test]
fn test_19_no_prompt_or_token_logging_during_operations() {
    // 1. Codebase audit: scan all Rust files in apps/agent/src/ipc to verify
    // that no log macro (info!, warn!, error!, debug!, trace!) prints token, prompt, or content.
    let ipc_src_dir = Path::new("src/ipc");
    if ipc_src_dir.exists() {
        for entry in fs::read_dir(ipc_src_dir).unwrap() {
            let entry = entry.unwrap();
            let content = fs::read_to_string(entry.path()).unwrap();
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("info!(")
                    || trimmed.starts_with("warn!(")
                    || trimmed.starts_with("error!(")
                    || trimmed.starts_with("debug!(")
                    || trimmed.starts_with("trace!(")
                {
                    assert!(
                        !line.contains("auth_payload.token"),
                        "Forbidden logging of token detected in {}",
                        entry.path().display()
                    );
                    assert!(
                        !line.contains("expected_token"),
                        "Forbidden logging of token detected in {}",
                        entry.path().display()
                    );
                    assert!(
                        !line.contains("req.payload"),
                        "Forbidden logging of request payload detected in {}",
                        entry.path().display()
                    );
                    assert!(
                        !line.contains("inspect_req.content"),
                        "Forbidden logging of inspect prompt detected in {}",
                        entry.path().display()
                    );
                }
            }
        }
    }

    // 2. Functional audit: Run IPC server and send sentinel token & sensitive prompt,
    // ensuring operational success.
    let test_dir = TestDirGuard::new("t19_no_prompt_logging");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());

    let mut client = IpcClient::connect(&socket_path).expect("connect client");
    assert!(client.authenticate(&token).expect("authenticate"));
    client.hello("0.1.0", 1).expect("hello");

    let sentinel_prompt = "TOP_SECRET_PROMPT_DO_NOT_LOG_987654321";
    let resp = client
        .inspect("VSCode", "chatgpt", sentinel_prompt)
        .expect("inspect");
    assert_eq!(resp.action, PolicyAction::Allow);

    drop(client);
    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// Test 20: V1 Native Messaging regression
// -----------------------------------------------------------------------------
#[test]
fn test_20_v1_native_messaging_regression() {
    let inspector = Inspector::new();

    // 1. Hello request in native host mode
    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: "native-hello-r3".to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::json!({
            "extension_version": "1.0.0",
            "protocol_version": 1
        }),
    };
    let hello_resp = shadowshield_agent::protocol_handler::handle_request(hello_req, &inspector);
    assert_eq!(hello_resp.msg_type, "HelloResponse");
    let hello_payload: HelloResponse = serde_json::from_value(hello_resp.payload).unwrap();
    assert!(hello_payload.compatible);
    assert_eq!(hello_payload.agent_version, "0.1.0-dev");

    // 2. Inspect request in native host mode
    let inspect_req = IpcRequest {
        protocol_version: 1,
        request_id: "native-insp-r3".to_string(),
        msg_type: "Inspect".to_string(),
        payload: serde_json::json!({
            "source": "Chrome",
            "ai_service": "chatgpt",
            "content": "4111 1111 1111 1111",
            "timestamp": 1728691200000u64
        }),
    };
    let inspect_resp =
        shadowshield_agent::protocol_handler::handle_request(inspect_req, &inspector);
    assert_eq!(inspect_resp.msg_type, "InspectResponse");
    let inspect_payload: InspectResponse = serde_json::from_value(inspect_resp.payload).unwrap();
    assert_eq!(inspect_payload.action, PolicyAction::Redact);
    assert_eq!(
        inspect_payload.sanitized_content,
        Some("[REDACTED:PAYMENT_CARD_NUMBER]".to_string())
    );
}
