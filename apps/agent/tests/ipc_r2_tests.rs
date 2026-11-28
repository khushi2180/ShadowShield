use byteorder::{LittleEndian, WriteBytesExt};
use shadowshield_agent::ipc::framing::{read_frame, read_message, write_message, FramingError};
use shadowshield_agent::ipc::{IpcClient, IpcServer, IpcServerConfig};
use shadowshield_core::Inspector;
use shadowshield_protocol::ipc::{
    EvaluateAiAccessRequest, HelloResponse, InspectRequest, InspectResponse, IpcErrorPayload,
    IpcErrorResponse, IpcRequest,
};
use shadowshield_protocol::{
    AiAccessDecision, AiAccessMode, AiAccessReason, AiService, AiServiceClassification,
    AiServiceId, PolicyAction, RiskLevel,
};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(100);

struct TestDirGuard {
    path: PathBuf,
}

impl TestDirGuard {
    fn new(_test_name: &str) -> Self {
        let count = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = PathBuf::from(format!("/tmp/ss-r2-{}-{}", std::process::id(), count));
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
        ..IpcServerConfig::default()
    };
    let server = IpcServer::new(config).expect("initialize IpcServer");
    let token = server.token().to_string();
    let socket_path = server.socket_path();
    (server, token, socket_path)
}

fn start_test_server_with_inspector(
    test_dir: &Path,
    inspector: Arc<Inspector>,
) -> (IpcServer, String, PathBuf) {
    let config = IpcServerConfig {
        runtime_dir: test_dir.to_path_buf(),
        max_clients: 8,
        handshake_timeout: Duration::from_millis(1000),
        idle_timeout: Duration::from_secs(5),
        ..IpcServerConfig::default()
    };
    let server = IpcServer::with_inspector(config, inspector).expect("initialize IpcServer");
    let token = server.token().to_string();
    let socket_path = server.socket_path();
    (server, token, socket_path)
}

// -----------------------------------------------------------------------------
// Test 1: Authenticate -> Hello -> EvaluateAiAccess flow
// -----------------------------------------------------------------------------
#[test]
fn test_01_authenticate_hello_evaluate_ai_access() {
    let test_dir = TestDirGuard::new("t01_auth_hello_eval");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    let hello = client.hello("1.0.0", 1).expect("hello");
    assert!(hello.compatible);

    let eval = client
        .evaluate_ai_access("chatgpt", AiAccessMode::Discovery)
        .expect("eval");
    assert_eq!(eval.service_id, "chatgpt");
    assert_eq!(eval.classification, AiServiceClassification::Approved);
    assert_eq!(eval.mode, AiAccessMode::Discovery);
    assert_eq!(eval.decision, AiAccessDecision::Allow);
    assert_eq!(eval.reason, AiAccessReason::ApprovedService);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 2: Approved service evaluation
// -----------------------------------------------------------------------------
#[test]
fn test_02_approved_service_evaluation() {
    let test_dir = TestDirGuard::new("t02_approved_service");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let eval = client
        .evaluate_ai_access("chatgpt", AiAccessMode::Policy)
        .expect("eval");
    assert_eq!(eval.service_id, "chatgpt");
    assert_eq!(eval.classification, AiServiceClassification::Approved);
    assert_eq!(eval.decision, AiAccessDecision::Allow);
    assert_eq!(eval.reason, AiAccessReason::ApprovedService);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 3: Unknown service under Policy mode
// -----------------------------------------------------------------------------
#[test]
fn test_03_unknown_service_policy_mode() {
    let test_dir = TestDirGuard::new("t03_unknown_policy");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let eval = client
        .evaluate_ai_access("claude", AiAccessMode::Policy)
        .expect("eval");
    assert_eq!(eval.service_id, "claude");
    assert_eq!(eval.classification, AiServiceClassification::Unknown);
    assert_eq!(eval.decision, AiAccessDecision::Coach);
    assert_eq!(eval.reason, AiAccessReason::UnknownService);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 4: Blocked service evaluation
// -----------------------------------------------------------------------------
#[test]
fn test_04_blocked_service_evaluation() {
    let test_dir = TestDirGuard::new("t04_blocked_service");
    let mut inspector = Inspector::new();
    inspector
        .register_ai_service(AiService {
            id: AiServiceId::new("malicious_ai").unwrap(),
            display_name: "Malicious AI".to_string(),
            vendor: "Shady Corp".to_string(),
            classification: AiServiceClassification::Blocked,
        })
        .expect("register blocked service");

    let (server, token, socket_path) =
        start_test_server_with_inspector(test_dir.path(), Arc::new(inspector));
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // 1. Explicitly Blocked Service
    let eval_blocked = client
        .evaluate_ai_access("malicious_ai", AiAccessMode::Policy)
        .expect("eval blocked");
    assert_eq!(eval_blocked.decision, AiAccessDecision::Block);
    assert_eq!(
        eval_blocked.classification,
        AiServiceClassification::Blocked
    );
    assert_eq!(eval_blocked.reason, AiAccessReason::BlockedService);

    // 2. StrictAllowlist blocks Unknown service
    let eval_strict = client
        .evaluate_ai_access("claude", AiAccessMode::StrictAllowlist)
        .expect("eval strict");
    assert_eq!(eval_strict.decision, AiAccessDecision::Block);
    assert_eq!(eval_strict.classification, AiServiceClassification::Unknown);
    assert_eq!(eval_strict.reason, AiAccessReason::UnknownService);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 5: Invalid service ID format
// -----------------------------------------------------------------------------
#[test]
fn test_05_invalid_service_id() {
    let test_dir = TestDirGuard::new("t05_invalid_service_id");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // Send invalid service_id with uppercase characters
    let req = IpcRequest {
        protocol_version: 1,
        request_id: "req-err-05".to_string(),
        msg_type: "EvaluateAiAccess".to_string(),
        payload: serde_json::json!({
            "service_id": "INVALID_UPPERCASE",
            "mode": "Policy"
        }),
    };
    client.send_request(&req).expect("send");
    let resp = client.read_response().expect("response");
    assert_eq!(resp.request_id, "req-err-05");
    assert_eq!(resp.msg_type, "Error");
    let err_payload: IpcErrorPayload = serde_json::from_value(resp.payload).expect("err payload");
    assert_eq!(err_payload.code, "invalid_request");

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 6: Invalid governance mode
// -----------------------------------------------------------------------------
#[test]
fn test_06_invalid_governance_mode() {
    let test_dir = TestDirGuard::new("t06_invalid_mode");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let req = IpcRequest {
        protocol_version: 1,
        request_id: "req-err-06".to_string(),
        msg_type: "EvaluateAiAccess".to_string(),
        payload: serde_json::json!({
            "service_id": "chatgpt",
            "mode": "NonExistentMode"
        }),
    };
    client.send_request(&req).expect("send");
    let resp = client.read_response().expect("response");
    assert_eq!(resp.request_id, "req-err-06");
    assert_eq!(resp.msg_type, "Error");
    let err_payload: IpcErrorPayload = serde_json::from_value(resp.payload).expect("err payload");
    assert_eq!(err_payload.code, "malformed_message");

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 7: Authenticate -> Hello -> Inspect flow
// -----------------------------------------------------------------------------
#[test]
fn test_07_authenticate_hello_inspect_flow() {
    let test_dir = TestDirGuard::new("t07_auth_hello_insp");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let insp = client
        .inspect(
            "VSCode",
            "chatgpt",
            "fn add(a: i32, b: i32) -> i32 { a + b }",
        )
        .expect("inspect");
    assert_eq!(insp.detections_count, 0);
    assert_eq!(insp.risk_assessment.level, RiskLevel::Low);
    assert_eq!(insp.action, PolicyAction::Allow);
    assert!(insp.sanitized_content.is_none());

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 8: Neutral text inspection
// -----------------------------------------------------------------------------
#[test]
fn test_08_neutral_text_inspect() {
    let test_dir = TestDirGuard::new("t08_neutral_text");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let insp = client
        .inspect(
            "BrowserExtension",
            "chatgpt",
            "Hello world, write a quick sort function in Python.",
        )
        .expect("inspect");
    assert_eq!(insp.detections_count, 0);
    assert_eq!(insp.risk_assessment.score, 0);
    assert_eq!(insp.risk_assessment.level, RiskLevel::Low);
    assert_eq!(insp.action, PolicyAction::Allow);
    assert!(insp.sanitized_content.is_none());

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 9: Approved Coach fixture inspection
// -----------------------------------------------------------------------------
#[test]
fn test_09_coach_fixture_inspect() {
    let test_dir = TestDirGuard::new("t09_coach_fixture");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // Email detector yields Severity::Medium (30) + PatternMatch (0) = 30 -> Medium -> Coach
    let content = "Please reach out to alice@example.com for further assistance.";
    let insp = client
        .inspect("VSCode", "chatgpt", content)
        .expect("inspect");
    assert!(insp.detections_count >= 1);
    assert_eq!(insp.risk_assessment.level, RiskLevel::Medium);
    assert_eq!(insp.action, PolicyAction::Coach);
    assert!(insp.sanitized_content.is_none());

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 10: Approved Redact fixture inspection
// -----------------------------------------------------------------------------
#[test]
fn test_10_redact_fixture_inspect() {
    let test_dir = TestDirGuard::new("t10_redact_fixture");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // Payment card: 4111 1111 1111 1111 yields Severity::High (60) + ChecksumValid (8) = 68 -> High -> Redact
    let content = "Card: 4111 1111 1111 1111";
    let insp = client
        .inspect("VSCode", "chatgpt", content)
        .expect("inspect");
    assert!(insp.detections_count >= 1);
    assert_eq!(insp.risk_assessment.level, RiskLevel::High);
    assert_eq!(insp.action, PolicyAction::Redact);
    assert_eq!(
        insp.sanitized_content,
        Some("Card: [REDACTED:PAYMENT_CARD_NUMBER]".to_string())
    );

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 11: Approved Block fixture inspection
// -----------------------------------------------------------------------------
#[test]
fn test_11_block_fixture_inspect() {
    let test_dir = TestDirGuard::new("t11_block_fixture");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // Private key yields Severity::Critical (90) + StructurallyValid (5) = 95 -> Critical -> Block
    let content = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----";
    let insp = client
        .inspect("VSCode", "chatgpt", content)
        .expect("inspect");
    assert!(insp.detections_count >= 1);
    assert_eq!(insp.risk_assessment.level, RiskLevel::Critical);
    assert_eq!(insp.action, PolicyAction::Block);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 12: Malformed Inspect payload
// -----------------------------------------------------------------------------
#[test]
fn test_12_malformed_inspect_payload() {
    let test_dir = TestDirGuard::new("t12_malformed_insp");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let req = IpcRequest {
        protocol_version: 1,
        request_id: "req-err-12".to_string(),
        msg_type: "Inspect".to_string(),
        payload: serde_json::json!({
            "source": 12345, // invalid type, expects String
            "invalid_field": true
        }),
    };
    client.send_request(&req).expect("send");
    let resp = client.read_response().expect("response");
    assert_eq!(resp.request_id, "req-err-12");
    assert_eq!(resp.msg_type, "Error");
    let err_payload: IpcErrorPayload = serde_json::from_value(resp.payload).expect("err payload");
    assert_eq!(err_payload.code, "malformed_message");

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 13: Unknown message type
// -----------------------------------------------------------------------------
#[test]
fn test_13_unknown_message_type() {
    let test_dir = TestDirGuard::new("t13_unknown_msg_type");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let req = IpcRequest {
        protocol_version: 1,
        request_id: "req-err-13".to_string(),
        msg_type: "NonExistentAction".to_string(),
        payload: serde_json::json!({}),
    };
    client.send_request(&req).expect("send");
    let resp = client.read_response().expect("response");
    assert_eq!(resp.request_id, "req-err-13");
    assert_eq!(resp.msg_type, "Error");
    let err_payload: IpcErrorPayload = serde_json::from_value(resp.payload).expect("err payload");
    assert_eq!(err_payload.code, "invalid_request");

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 14: Incorrect protocol version
// -----------------------------------------------------------------------------
#[test]
fn test_14_incorrect_protocol_version() {
    let test_dir = TestDirGuard::new("t14_unsupported_version");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    let req = IpcRequest {
        protocol_version: 99,
        request_id: "req-err-14".to_string(),
        msg_type: "Health".to_string(),
        payload: serde_json::json!({}),
    };
    client.send_request(&req).expect("send");
    let resp = client.read_response().expect("response");
    assert_eq!(resp.request_id, "req-err-14");
    assert_eq!(resp.msg_type, "Error");
    let err_payload: IpcErrorPayload = serde_json::from_value(resp.payload).expect("err payload");
    assert_eq!(err_payload.code, "unsupported_protocol");

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 15: Request ID preservation across requests
// -----------------------------------------------------------------------------
#[test]
fn test_15_request_id_preservation() {
    let test_dir = TestDirGuard::new("t15_req_id_preservation");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));
    client.hello("1.0.0", 1).expect("hello");

    // 1. EvaluateAiAccess request ID
    let custom_id_1 = "req-uuid-eval-123456789";
    let req1 = IpcRequest {
        protocol_version: 1,
        request_id: custom_id_1.to_string(),
        msg_type: "EvaluateAiAccess".to_string(),
        payload: serde_json::to_value(EvaluateAiAccessRequest {
            service_id: "chatgpt".to_string(),
            mode: AiAccessMode::Policy,
        })
        .unwrap(),
    };
    client.send_request(&req1).expect("send req1");
    let resp1 = client.read_response().expect("resp1");
    assert_eq!(resp1.request_id, custom_id_1);

    // 2. Inspect request ID
    let custom_id_2 = "req-uuid-inspect-987654321";
    let req2 = IpcRequest {
        protocol_version: 1,
        request_id: custom_id_2.to_string(),
        msg_type: "Inspect".to_string(),
        payload: serde_json::to_value(InspectRequest {
            source: "VSCode".to_string(),
            ai_service: "chatgpt".to_string(),
            content: "clean content".to_string(),
            timestamp: 12345,
        })
        .unwrap(),
    };
    client.send_request(&req2).expect("send req2");
    let resp2 = client.read_response().expect("resp2");
    assert_eq!(resp2.request_id, custom_id_2);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 16: Sequential requests over same authenticated connection
// -----------------------------------------------------------------------------
#[test]
fn test_16_sequential_requests_same_connection() {
    let test_dir = TestDirGuard::new("t16_sequential_requests");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut client = IpcClient::connect(&socket_path).expect("connect");
    assert!(client.authenticate(&token).expect("auth"));

    // 1. Hello
    let hello = client.hello("1.0.0", 1).expect("hello");
    assert!(hello.compatible);

    // 2. Health
    let health = client.health().expect("health");
    assert!(health.agent_running);

    // 3. EvaluateAiAccess
    let eval = client
        .evaluate_ai_access("chatgpt", AiAccessMode::Policy)
        .expect("eval");
    assert_eq!(eval.decision, AiAccessDecision::Allow);

    // 4. Inspect Neutral
    let insp1 = client
        .inspect("VSCode", "chatgpt", "clean prompt")
        .expect("insp1");
    assert_eq!(insp1.action, PolicyAction::Allow);

    // 5. Inspect Coach (Email)
    let insp2 = client
        .inspect("VSCode", "chatgpt", "email: bob@example.com")
        .expect("insp2");
    assert_eq!(insp2.action, PolicyAction::Coach);

    // 6. Inspect Redact (Card)
    let insp3 = client
        .inspect("VSCode", "chatgpt", "card: 4111 1111 1111 1111")
        .expect("insp3");
    assert_eq!(insp3.action, PolicyAction::Redact);

    // 7. Inspect Block (Private key)
    let insp4 = client
        .inspect(
            "VSCode",
            "chatgpt",
            "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----",
        )
        .expect("insp4");
    assert_eq!(insp4.action, PolicyAction::Block);

    // 8. Health again
    let health2 = client.health().expect("health2");
    assert!(health2.inspection_engine_available);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 17: Concurrent clients
// -----------------------------------------------------------------------------
#[test]
fn test_17_concurrent_clients() {
    let test_dir = TestDirGuard::new("t17_concurrent_clients");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut handles = Vec::new();
    for i in 0..6 {
        let sock_path = socket_path.clone();
        let tok = token.clone();
        let handle = thread::spawn(move || {
            let mut client = IpcClient::connect(&sock_path).expect("connect");
            assert!(client.authenticate(&tok).expect("auth"));
            client.hello("1.0.0", 1).expect("hello");

            let eval = client
                .evaluate_ai_access("chatgpt", AiAccessMode::Policy)
                .expect("eval");
            assert_eq!(eval.decision, AiAccessDecision::Allow);

            let insp = client
                .inspect("VSCode", "chatgpt", &format!("Worker {} clean prompt", i))
                .expect("insp");
            assert_eq!(insp.action, PolicyAction::Allow);
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().expect("worker thread join");
    }

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 18: Client disconnect during inspection (BrokenPipe detection)
// -----------------------------------------------------------------------------
#[test]
fn test_18_client_disconnect_during_inspection() {
    let test_dir = TestDirGuard::new("t18_disconnect_broken_pipe");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    {
        let mut client = IpcClient::connect(&socket_path).expect("connect");
        assert!(client.authenticate(&token).expect("auth"));
        client.hello("1.0.0", 1).expect("hello");

        // Send inspect request and immediately drop client to trigger BrokenPipe on server write
        let req = IpcRequest {
            protocol_version: 1,
            request_id: "req-disconnect".to_string(),
            msg_type: "Inspect".to_string(),
            payload: serde_json::to_value(InspectRequest {
                source: "VSCode".to_string(),
                ai_service: "chatgpt".to_string(),
                content: "Content to be dropped by client".to_string(),
                timestamp: 12345,
            })
            .unwrap(),
        };
        client.send_request(&req).expect("send");
        // Drop client immediately
        drop(client);
    }

    // Give server worker time to process and detect BrokenPipe
    thread::sleep(Duration::from_millis(100));

    // Server must still be healthy and accepting new clients
    let mut client2 = IpcClient::connect(&socket_path).expect("connect client 2");
    assert!(client2.authenticate(&token).expect("auth client 2"));
    client2.hello("1.0.0", 1).expect("hello client 2");
    let health = client2.health().expect("health client 2");
    assert!(health.agent_running);

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 19: Oversized frame (> 10 MiB)
// -----------------------------------------------------------------------------
#[test]
fn test_19_oversized_frame() {
    let test_dir = TestDirGuard::new("t19_oversized_frame");
    let (server, token, socket_path) = start_test_server(test_dir.path());
    let shutdown_handle = server.shutdown_handle();
    let server_handle = thread::spawn(move || server.run());
    thread::sleep(Duration::from_millis(50));

    let mut stream = UnixStream::connect(&socket_path).expect("connect stream");

    // Authenticate first
    let auth_req = IpcRequest {
        protocol_version: 1,
        request_id: "auth-init".to_string(),
        msg_type: "Authenticate".to_string(),
        payload: serde_json::json!({ "token": token }),
    };
    write_message(&mut stream, &auth_req).expect("write auth");
    let _auth_resp = read_frame(&mut stream).expect("read auth");

    // Write oversized frame length (> 10 MiB)
    let oversized_len: u32 = 11 * 1024 * 1024;
    stream
        .write_u32::<LittleEndian>(oversized_len)
        .expect("write header");

    // Server should reject and send message_too_large error
    let resp: Result<IpcErrorResponse, FramingError> = read_message(&mut stream);
    match resp {
        Ok(err) => {
            assert_eq!(err.payload.code, "message_too_large");
        }
        Err(FramingError::Io(_)) => {
            // Disconnection by server on oversized frame is also valid
        }
        Err(e) => panic!("Unexpected error on oversized frame: {:?}", e),
    }

    shutdown_handle.shutdown();
    server_handle.join().expect("join");
}

// -----------------------------------------------------------------------------
// Test 20: V1 Native Messaging compatibility
// -----------------------------------------------------------------------------
#[test]
fn test_20_v1_native_messaging_compatibility() {
    let inspector = Inspector::new();

    // 1. Hello request in native host mode
    let hello_req = IpcRequest {
        protocol_version: 1,
        request_id: "native-hello-1".to_string(),
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
        request_id: "native-insp-1".to_string(),
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
