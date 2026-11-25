use byteorder::{LittleEndian, WriteBytesExt};
use shadowshield_agent::ipc::framing::{read_frame, read_message, write_message, FramingError};
use shadowshield_agent::ipc::{IpcClient, IpcServer, IpcServerConfig, MAX_MESSAGE_SIZE};
use shadowshield_protocol::ipc::{IpcErrorResponse, IpcRequest, IpcResponse};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

struct TestDirGuard {
    path: PathBuf,
}

impl TestDirGuard {
    fn new(_test_name: &str) -> Self {
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = PathBuf::from(format!("/tmp/ss-r1-{}-{}", std::process::id(), count));
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
        max_clients: 4,
        handshake_timeout: Duration::from_millis(500),
        idle_timeout: Duration::from_secs(5),
    };
    let server = IpcServer::new(config).expect("initialize IpcServer");
    let token = server.token().to_string();
    let socket_path = server.socket_path();
    (server, token, socket_path)
}

#[test]
fn test_valid_authenticate_and_hello() {
    let test_dir = TestDirGuard::new("valid_auth_hello");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect to IPC socket");

    // 1. Authenticate
    let auth_ok = client.authenticate(&token).expect("authenticate");
    assert!(auth_ok);

    // 2. Hello
    let hello_resp = client.hello("0.1.0", 1).expect("hello");
    assert!(hello_resp.compatible);
    assert_eq!(hello_resp.protocol_version, 1);
    assert_eq!(hello_resp.agent_version, "0.1.0-dev");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_valid_health_query() {
    let test_dir = TestDirGuard::new("valid_health");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect to IPC socket");
    assert!(client.authenticate(&token).expect("authenticate"));
    client.hello("0.1.0", 1).expect("hello");

    let health_resp = client.health().expect("health");
    assert!(health_resp.agent_running);
    assert!(health_resp.inspection_engine_available);
    assert_eq!(health_resp.protocol_version, 1);

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_invalid_authentication_token_rejected() {
    let test_dir = TestDirGuard::new("invalid_token");
    let (server, _token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect to IPC socket");
    let bad_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let req = IpcRequest {
        protocol_version: 1,
        request_id: "test-auth-fail".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": bad_token }),
    };
    client.send_request(&req).expect("send request");

    let err_resp: IpcErrorResponse =
        read_message(client.stream_mut()).expect("read error response");
    assert_eq!(err_resp.payload.code, "unauthorized");

    // Verify stream was disconnected
    let next_read: Result<IpcResponse, FramingError> = read_message(client.stream_mut());
    assert!(matches!(next_read, Err(FramingError::ConnectionClosed)));

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_incorrect_message_ordering_rejected() {
    let test_dir = TestDirGuard::new("incorrect_order");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    // Case 1: Send Hello directly without Authenticate
    {
        let mut client = IpcClient::connect(&socket_path).expect("connect");
        let hello_req = IpcRequest {
            protocol_version: 1,
            request_id: "premature-hello".to_string(),
            msg_type: "Hello".to_string(),
            payload: serde_json::json!({
                "extension_version": "0.1.0",
                "protocol_version": 1
            }),
        };
        client.send_request(&hello_req).expect("send hello");

        let err_resp: IpcErrorResponse =
            read_message(client.stream_mut()).expect("read error response");
        assert_eq!(err_resp.payload.code, "unauthorized");

        // Verify connection dropped
        let res: Result<IpcResponse, FramingError> = read_message(client.stream_mut());
        assert!(matches!(res, Err(FramingError::ConnectionClosed)));
    }

    // Case 2: Send Health directly without Authenticate
    {
        let mut client = IpcClient::connect(&socket_path).expect("connect");
        let health_req = IpcRequest {
            protocol_version: 1,
            request_id: "premature-health".to_string(),
            msg_type: "Health".to_string(),
            payload: serde_json::json!({}),
        };
        client.send_request(&health_req).expect("send health");

        let err_resp: IpcErrorResponse =
            read_message(client.stream_mut()).expect("read error response");
        assert_eq!(err_resp.payload.code, "unauthorized");

        let res: Result<IpcResponse, FramingError> = read_message(client.stream_mut());
        assert!(matches!(res, Err(FramingError::ConnectionClosed)));
    }

    // Case 3: Send Authenticate, then send Health directly BEFORE Hello
    {
        let mut client = IpcClient::connect(&socket_path).expect("connect");
        assert!(client.authenticate(&token).expect("authenticate"));

        let health_req = IpcRequest {
            protocol_version: 1,
            request_id: "health-before-hello".to_string(),
            msg_type: "Health".to_string(),
            payload: serde_json::json!({}),
        };
        client
            .send_request(&health_req)
            .expect("send premature health");

        let err_resp: IpcErrorResponse =
            read_message(client.stream_mut()).expect("read error response");
        assert_eq!(err_resp.payload.code, "unauthorized");
        assert!(err_resp.payload.message.contains("Hello required"));

        let res: Result<IpcResponse, FramingError> = read_message(client.stream_mut());
        assert!(matches!(res, Err(FramingError::ConnectionClosed)));
    }

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_oversized_frame_rejected_without_oom() {
    let test_dir = TestDirGuard::new("oversized_frame");
    let (server, _token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut stream = UnixStream::connect(&socket_path).expect("connect");

    // Write a length header that exceeds MAX_MESSAGE_SIZE (10 MiB)
    let oversized_len = MAX_MESSAGE_SIZE + 1024;
    let mut header = Vec::new();
    header.write_u32::<LittleEndian>(oversized_len).unwrap();
    stream.write_all(&header).expect("write oversized header");

    let err_resp: IpcErrorResponse = read_message(&mut stream).expect("read error response");
    assert_eq!(err_resp.payload.code, "message_too_large");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_fragmented_frame_handling() {
    let test_dir = TestDirGuard::new("fragmented_frame");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut stream = UnixStream::connect(&socket_path).expect("connect");

    let req = IpcRequest {
        protocol_version: 1,
        request_id: "frag-1".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };

    let mut full_frame = Vec::new();
    write_message(&mut full_frame, &req).unwrap();

    // Send the frame in tiny byte chunks with small delays to simulate fragmentation
    for chunk in full_frame.chunks(7) {
        stream.write_all(chunk).expect("write chunk");
        thread::sleep(Duration::from_millis(2));
    }

    let resp: IpcResponse = read_message(&mut stream).expect("read auth response");
    assert_eq!(resp.msg_type, "AuthenticateResponse");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_coalesced_frames_handling() {
    let test_dir = TestDirGuard::new("coalesced_frames");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut stream = UnixStream::connect(&socket_path).expect("connect");

    let auth_req = IpcRequest {
        protocol_version: 1,
        request_id: "coal-auth".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };
    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: "coal-hello".to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::json!({ "extension_version": "0.1.0", "protocol_version": 1 }),
    };

    let mut coalesced = Vec::new();
    write_message(&mut coalesced, &auth_req).unwrap();
    write_message(&mut coalesced, &hello_req).unwrap();

    // Write both frames in a single segment
    stream.write_all(&coalesced).expect("write coalesced");

    let auth_resp: IpcResponse = read_message(&mut stream).expect("read auth response");
    assert_eq!(auth_resp.request_id, "coal-auth");

    let hello_resp: IpcResponse = read_message(&mut stream).expect("read hello response");
    assert_eq!(hello_resp.request_id, "coal-hello");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_handshake_timeout() {
    let test_dir = TestDirGuard::new("handshake_timeout");
    let (server, _token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut stream = UnixStream::connect(&socket_path).expect("connect");

    // Sleep longer than the 500ms handshake timeout configured on the test server
    thread::sleep(Duration::from_millis(700));

    // Subsequent read or write should detect connection closure by the server
    let read_result = read_frame(&mut stream);
    assert!(matches!(
        read_result,
        Err(FramingError::ConnectionClosed) | Err(FramingError::Io(_))
    ));

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_duplicate_daemon_startup_rejected() {
    let test_dir = TestDirGuard::new("duplicate_startup");
    let (server1, _token, _socket) = start_test_server(test_dir.path());

    // Attempt to start a second server on the same runtime directory
    let config2 = IpcServerConfig {
        runtime_dir: test_dir.path().to_path_buf(),
        max_clients: 4,
        handshake_timeout: Duration::from_millis(500),
        idle_timeout: Duration::from_secs(5),
    };

    let res2 = IpcServer::new(config2);
    assert!(res2.is_err());
    let err = res2.err().unwrap();
    assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);

    drop(server1);
}

#[test]
fn test_stale_socket_recovery() {
    let test_dir = TestDirGuard::new("stale_socket");
    let socket_path = test_dir.path().join("agent.sock");

    // Simulate an abandoned/stale socket file from an unclean crash
    {
        let dead_listener = UnixListener::bind(&socket_path).expect("bind temporary dead socket");
        drop(dead_listener);
    }
    assert!(socket_path.exists());

    // Start server: should detect stale socket via ECONNREFUSED probe, unlink it, and bind cleanly
    let (server, token, _) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect after stale recovery");
    let auth_ok = client.authenticate(&token).expect("authenticate");
    assert!(auth_ok);

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_symlink_runtime_path_rejected() {
    let test_dir = TestDirGuard::new("symlink_path");
    let real_dir = test_dir.path().join("real_runtime");
    fs::create_dir_all(&real_dir).unwrap();

    let symlink_dir = test_dir.path().join("symlink_runtime");
    std::os::unix::fs::symlink(&real_dir, &symlink_dir).unwrap();

    let config = IpcServerConfig {
        runtime_dir: symlink_dir,
        max_clients: 4,
        handshake_timeout: Duration::from_millis(500),
        idle_timeout: Duration::from_secs(5),
    };

    let res = IpcServer::new(config);
    assert!(res.is_err());
    let err = res.err().unwrap();
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn test_daemon_restart_and_token_rotation() {
    let test_dir = TestDirGuard::new("restart_rotation");
    let socket_path = test_dir.path().join("agent.sock");

    let token1 = {
        let (server1, t1, _) = start_test_server(test_dir.path());
        let shutdown1 = server1.shutdown_handle();
        let handle1 = thread::spawn(move || server1.run());
        thread::sleep(Duration::from_millis(50));

        let mut client1 = IpcClient::connect(&socket_path).expect("connect client 1");
        assert!(client1.authenticate(&t1).expect("auth client 1"));

        shutdown1.shutdown();
        handle1.join().unwrap();
        t1
    };

    // Restart server in the same directory: new token is generated
    let (server2, token2, _) = start_test_server(test_dir.path());
    assert_ne!(token1, token2); // Token rotated!

    let shutdown2 = server2.shutdown_handle();
    let handle2 = thread::spawn(move || server2.run());
    thread::sleep(Duration::from_millis(50));

    // Old token must be rejected
    let mut client_bad = IpcClient::connect(&socket_path).expect("connect client with old token");
    let bad_auth = client_bad.authenticate(&token1);
    assert!(!bad_auth.unwrap_or(false));

    // New token must succeed
    let mut client_good = IpcClient::connect(&socket_path).expect("connect client with new token");
    let good_auth = client_good.authenticate(&token2).expect("auth client 2");
    assert!(good_auth);

    shutdown2.shutdown();
    handle2.join().unwrap();
}

#[test]
fn test_inspect_and_eval_ai_not_supported_in_r1() {
    let test_dir = TestDirGuard::new("inspect_not_supported");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    let hello = client.hello("0.1.0", 1).expect("hello");
    assert!(hello.compatible);

    // Try sending Inspect
    let inspect_req = IpcRequest {
        protocol_version: 1,
        request_id: "inspect-r1".to_string(),
        msg_type: "Inspect".to_string(),
        payload: serde_json::json!({
            "source": "VSCode",
            "ai_service": "chatgpt",
            "content": "test prompt",
            "timestamp": 123456
        }),
    };
    client.send_request(&inspect_req).unwrap();

    let err_resp: IpcErrorResponse = read_message(client.stream_mut()).unwrap();
    assert_eq!(err_resp.payload.code, "invalid_request");
    assert!(err_resp.payload.message.contains("not supported in R1"));

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_shared_handshake_timeout_expires_on_hello() {
    let test_dir = TestDirGuard::new("handshake_shared_timeout");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");

    // Authenticate immediately at t=0
    assert!(client.authenticate(&token).expect("auth"));

    // Sleep 700ms (exceeding test server's 500ms handshake timeout) before sending Hello
    thread::sleep(Duration::from_millis(700));

    // Sending Hello now should fail or be dropped because 500ms handshake deadline expired
    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: "late-hello".to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::json!({
            "extension_version": "0.1.0",
            "protocol_version": 1
        }),
    };
    let send_res = client.send_request(&hello_req);
    if send_res.is_ok() {
        let resp: Result<IpcResponse, FramingError> = read_message(client.stream_mut());
        assert!(matches!(
            resp,
            Err(FramingError::ConnectionClosed) | Err(FramingError::Io(_))
        ));
    }

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_malformed_and_zero_length_frame() {
    let test_dir = TestDirGuard::new("malformed_frame");
    let (server, _token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    // Case 1: Zero-length payload frame ([0, 0, 0, 0])
    {
        let mut stream = UnixStream::connect(&socket_path).expect("connect");
        stream
            .write_all(&0u32.to_le_bytes())
            .expect("write 0-length header");
        let resp: IpcErrorResponse = read_message(&mut stream).expect("read error response");
        assert_eq!(resp.payload.code, "malformed_message");
    }

    // Case 2: Non-JSON payload
    {
        let mut stream = UnixStream::connect(&socket_path).expect("connect");
        let bad_payload = b"not a json object";
        let len = bad_payload.len() as u32;
        stream.write_all(&len.to_le_bytes()).unwrap();
        stream.write_all(bad_payload).unwrap();
        let resp: IpcErrorResponse = read_message(&mut stream).expect("read error response");
        assert_eq!(resp.payload.code, "malformed_message");
    }

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

#[test]
fn test_max_concurrent_connections_bound() {
    let test_dir = TestDirGuard::new("max_clients");
    let (server, token, socket_path) = start_test_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    // Connect max_clients (4) active clients
    let mut clients = Vec::new();
    for _ in 0..4 {
        let mut client = IpcClient::connect(&socket_path).expect("connect client");
        assert!(client.authenticate(&token).expect("auth client"));
        clients.push(client);
    }

    // 5th client should be rejected/dropped by the connection bound
    let mut overflow_client = IpcClient::connect(&socket_path).expect("connect 5th client");
    let res = overflow_client.authenticate(&token);
    assert!(!res.unwrap_or(false));

    drop(clients);
    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}
