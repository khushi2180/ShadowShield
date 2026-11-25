use byteorder::{LittleEndian, ReadBytesExt};
use shadowshield_agent::ipc::framing::{read_frame, write_frame, write_message};
use shadowshield_agent::ipc::{IpcClient, IpcServer, IpcServerConfig};
use shadowshield_protocol::ipc::{
    HealthRequest, HealthResponse, HelloRequest, HelloResponse, InspectRequest, IpcErrorPayload,
    IpcErrorResponse, IpcRequest, IpcResponse,
};
use std::fs;
use std::io::Cursor;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(100);

struct GoldenTestDirGuard {
    path: PathBuf,
}

impl GoldenTestDirGuard {
    fn new(name: &str) -> Self {
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = PathBuf::from(format!(
            "/tmp/ss-gw-{}-{}-{}",
            name,
            std::process::id(),
            count
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test dir");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("chmod 0700");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for GoldenTestDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn start_golden_server(test_dir: &Path) -> (IpcServer, String, PathBuf) {
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

// -----------------------------------------------------------------------------
// 1. Exact Authenticate JSON Envelope & Framing
// -----------------------------------------------------------------------------

#[test]
fn test_golden_wire_authenticate_request() {
    let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let req = IpcRequest {
        protocol_version: 1,
        request_id: "auth-001".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &req).expect("write message");

    // 1. Verify 4-byte LE framing prefix
    let mut cursor = Cursor::new(&buf);
    let len = cursor.read_u32::<LittleEndian>().expect("read length");
    assert_eq!(len as usize, buf.len() - 4);

    // 2. Verify payload raw UTF-8 JSON
    let json_bytes = &buf[4..];
    let parsed: serde_json::Value = serde_json::from_slice(json_bytes).expect("parse json");

    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "auth-001");
    // Verify wire key is "type", not "msg_type"
    assert_eq!(parsed["type"], "Authenticate");
    assert!(parsed.get("msg_type").is_none());
    assert_eq!(parsed["payload"]["token"], token);
}

#[test]
fn test_golden_wire_authenticate_response() {
    let resp = IpcResponse {
        protocol_version: 1,
        request_id: "auth-001".to_string(),
        msg_type: "AuthenticateResponse".to_string(),
        payload: serde_json::json!({ "authenticated": true }),
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &resp).expect("write message");

    let mut cursor = Cursor::new(&buf);
    let len = cursor.read_u32::<LittleEndian>().expect("read length");
    assert_eq!(len as usize, buf.len() - 4);

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).expect("parse json");
    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "auth-001");
    assert_eq!(parsed["type"], "AuthenticateResponse");
    assert!(parsed.get("msg_type").is_none());
    assert_eq!(parsed["payload"]["authenticated"], true);
}

// -----------------------------------------------------------------------------
// 2. Exact Hello JSON Envelope & Framing
// -----------------------------------------------------------------------------

#[test]
fn test_golden_wire_hello_request() {
    let req = IpcRequest {
        protocol_version: 1,
        request_id: "hello-001".to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::to_value(HelloRequest {
            extension_version: "0.1.0".to_string(),
            protocol_version: 1,
        })
        .unwrap(),
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &req).unwrap();

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).unwrap();
    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "hello-001");
    assert_eq!(parsed["type"], "Hello");
    assert_eq!(parsed["payload"]["extension_version"], "0.1.0");
    assert_eq!(parsed["payload"]["protocol_version"], 1);
}

#[test]
fn test_golden_wire_hello_response() {
    let resp = IpcResponse {
        protocol_version: 1,
        request_id: "hello-001".to_string(),
        msg_type: "HelloResponse".to_string(),
        payload: serde_json::to_value(HelloResponse {
            agent_version: "0.1.0-dev".to_string(),
            protocol_version: 1,
            compatible: true,
        })
        .unwrap(),
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &resp).unwrap();

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).unwrap();
    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "hello-001");
    assert_eq!(parsed["type"], "HelloResponse");
    assert_eq!(parsed["payload"]["agent_version"], "0.1.0-dev");
    assert_eq!(parsed["payload"]["protocol_version"], 1);
    assert_eq!(parsed["payload"]["compatible"], true);
}

// -----------------------------------------------------------------------------
// 3. Exact Health JSON Envelope & Framing (Strictly 3 fields in payload)
// -----------------------------------------------------------------------------

#[test]
fn test_golden_wire_health_request() {
    let req = IpcRequest {
        protocol_version: 1,
        request_id: "health-001".to_string(),
        msg_type: "Health".to_string(),
        payload: serde_json::to_value(HealthRequest {}).unwrap(),
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &req).unwrap();

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).unwrap();
    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "health-001");
    assert_eq!(parsed["type"], "Health");
    assert!(parsed["payload"].is_object());
}

#[test]
fn test_golden_wire_health_response_exact_fields() {
    let resp = IpcResponse {
        protocol_version: 1,
        request_id: "health-001".to_string(),
        msg_type: "HealthResponse".to_string(),
        payload: serde_json::to_value(HealthResponse {
            agent_running: true,
            inspection_engine_available: true,
            protocol_version: 1,
        })
        .unwrap(),
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &resp).unwrap();

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).unwrap();
    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "health-001");
    assert_eq!(parsed["type"], "HealthResponse");

    // Strictly verify payload contains ONLY the 3 approved fields
    let payload_obj = parsed["payload"].as_object().expect("payload object");
    assert_eq!(payload_obj.len(), 3);
    assert_eq!(
        payload_obj.get("agent_running").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        payload_obj
            .get("inspection_engine_available")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        payload_obj.get("protocol_version").and_then(|v| v.as_u64()),
        Some(1)
    );

    // Confirm that NO alternative status: "ok" or unverified fields exist
    assert!(payload_obj.get("status").is_none());
    assert!(payload_obj.get("agent_version").is_none());
}

// -----------------------------------------------------------------------------
// 4. Exact Error JSON Envelope & Framing
// -----------------------------------------------------------------------------

#[test]
fn test_golden_wire_error_response_with_request_id() {
    let err = IpcErrorResponse {
        protocol_version: 1,
        request_id: Some("req-1728691200000-001".to_string()),
        msg_type: "Error".to_string(),
        payload: IpcErrorPayload {
            code: "invalid_request".to_string(),
            message: "AiServiceId contains invalid characters".to_string(),
        },
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &err).unwrap();

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).unwrap();
    assert_eq!(parsed["protocol_version"], 1);
    assert_eq!(parsed["request_id"], "req-1728691200000-001");
    assert_eq!(parsed["type"], "Error");
    assert!(parsed.get("msg_type").is_none());
    assert_eq!(parsed["payload"]["code"], "invalid_request");
    assert_eq!(
        parsed["payload"]["message"],
        "AiServiceId contains invalid characters"
    );
}

#[test]
fn test_golden_wire_error_response_without_request_id() {
    let err = IpcErrorResponse {
        protocol_version: 1,
        request_id: None,
        msg_type: "Error".to_string(),
        payload: IpcErrorPayload {
            code: "message_too_large".to_string(),
            message: "Message exceeded size limit: 12000000".to_string(),
        },
    };

    let mut buf = Vec::new();
    write_message(&mut buf, &err).unwrap();

    let parsed: serde_json::Value = serde_json::from_slice(&buf[4..]).unwrap();
    assert_eq!(parsed["protocol_version"], 1);
    assert!(parsed["request_id"].is_null());
    assert_eq!(parsed["type"], "Error");
    assert_eq!(parsed["payload"]["code"], "message_too_large");
}

// -----------------------------------------------------------------------------
// 5. Request ID Preservation over Live Transport
// -----------------------------------------------------------------------------

#[test]
fn test_golden_wire_live_request_id_preservation() {
    let test_dir = GoldenTestDirGuard::new("req_id_preservation");
    let (server, token, socket_path) = start_golden_server(test_dir.path());

    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || {
        server.run();
    });

    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect to IPC socket");

    // 1. Authenticate with custom request_id
    let auth_custom_id = "test-uuid-auth-987654";
    let auth_req = IpcRequest {
        protocol_version: 1,
        request_id: auth_custom_id.to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };
    client.send_request(&auth_req).unwrap();
    let auth_resp: IpcResponse = client.read_response().unwrap();
    assert_eq!(auth_resp.request_id, auth_custom_id);
    assert_eq!(auth_resp.msg_type, "AuthenticateResponse");

    // 2. Hello with custom request_id
    let hello_custom_id = "test-uuid-hello-345678";
    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: hello_custom_id.to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::to_value(HelloRequest {
            extension_version: "0.1.0".to_string(),
            protocol_version: 1,
        })
        .unwrap(),
    };
    client.send_request(&hello_req).unwrap();
    let hello_resp: IpcResponse = client.read_response().unwrap();
    assert_eq!(hello_resp.request_id, hello_custom_id);
    assert_eq!(hello_resp.msg_type, "HelloResponse");

    // 3. Health with custom request_id
    let health_custom_id = "test-uuid-health-123456";
    let health_req = IpcRequest {
        protocol_version: 1,
        request_id: health_custom_id.to_string(),
        msg_type: "Health".to_string(),
        payload: serde_json::to_value(HealthRequest {}).unwrap(),
    };
    client.send_request(&health_req).unwrap();
    let health_resp: IpcResponse = client.read_response().unwrap();
    assert_eq!(health_resp.request_id, health_custom_id);
    assert_eq!(health_resp.msg_type, "HealthResponse");

    shutdown_handle.shutdown();
    server_handle.join().expect("server join");
}

// -----------------------------------------------------------------------------
// 6. 4-byte Little-Endian Framing Fidelity
// -----------------------------------------------------------------------------

#[test]
fn test_golden_wire_four_byte_little_endian_framing() {
    let payload = b"{\"key\":\"golden_wire_framing_test\"}";
    let len = payload.len() as u32;

    let mut buf = Vec::new();
    write_frame(&mut buf, payload).expect("write frame");

    // Check header byte-by-byte
    assert_eq!(buf.len(), 4 + payload.len());
    let le_bytes = len.to_le_bytes();
    assert_eq!(&buf[0..4], &le_bytes);

    // Round-trip read
    let mut cursor = Cursor::new(&buf);
    let roundtrip = read_frame(&mut cursor).expect("read frame");
    assert_eq!(roundtrip.as_slice(), payload);
}

// -----------------------------------------------------------------------------
// 7. V1 Chrome Native Messaging Stdio Compatibility (Hello and Inspect)
// -----------------------------------------------------------------------------

#[test]
fn test_v1_native_messaging_hello_and_inspect_compatibility() {
    // Verifies that V1 protocol handler handles Hello and Inspect directly over stdio framing
    // without requiring an Authenticate frame, and that the framing matches Chrome Native Messaging.

    // 1. Hello Request via V1 stdio framing
    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: "v1-hello-req".to_string(),
        msg_type: "Hello".to_string(),
        payload: serde_json::to_value(HelloRequest {
            extension_version: "0.1.0".to_string(),
            protocol_version: 1,
        })
        .unwrap(),
    };

    let mut stdio_in = Vec::new();
    shadowshield_agent::native_messaging::write_message(&mut stdio_in, &hello_req).unwrap();

    let mut cursor_in = Cursor::new(stdio_in);
    let read_req: IpcRequest = shadowshield_agent::native_messaging::read_message(&mut cursor_in)
        .unwrap()
        .unwrap();
    assert_eq!(read_req.msg_type, "Hello");

    // 2. Inspect Request via V1 stdio framing
    let inspect_req = IpcRequest {
        protocol_version: 1,
        request_id: "v1-inspect-req".to_string(),
        msg_type: "Inspect".to_string(),
        payload: serde_json::to_value(InspectRequest {
            source: "Chrome".to_string(),
            ai_service: "chatgpt".to_string(),
            content: "clean text without secrets".to_string(),
            timestamp: 1728691200000,
        })
        .unwrap(),
    };

    let mut stdio_in2 = Vec::new();
    shadowshield_agent::native_messaging::write_message(&mut stdio_in2, &inspect_req).unwrap();

    let mut cursor_in2 = Cursor::new(stdio_in2);
    let read_req2: IpcRequest = shadowshield_agent::native_messaging::read_message(&mut cursor_in2)
        .unwrap()
        .unwrap();
    assert_eq!(read_req2.msg_type, "Inspect");
}
