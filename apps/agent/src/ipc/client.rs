use shadowshield_protocol::ipc::{
    EvaluateAiAccessRequest, EvaluateAiAccessResponse, HealthRequest, HealthResponse, HelloRequest,
    HelloResponse, InspectRequest, InspectResponse, IpcRequest, IpcResponse,
};
use shadowshield_protocol::AiAccessMode;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::Path;

use super::framing::{read_message, write_message, FramingError};

const PROTOCOL_VERSION: u32 = 1;

pub struct IpcClient {
    stream: UnixStream,
}

impl IpcClient {
    pub fn connect(socket_path: &Path) -> io::Result<Self> {
        let stream = UnixStream::connect(socket_path)?;
        Ok(Self { stream })
    }

    pub fn stream_mut(&mut self) -> &mut UnixStream {
        &mut self.stream
    }

    pub fn authenticate(&mut self, token: &str) -> Result<bool, FramingError> {
        let req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "auth-init".to_string(),
            msg_type: "Authenticate".to_string(),
            payload: serde_json::json!({ "token": token }),
        };
        write_message(&mut self.stream, &req)?;
        let frame = super::framing::read_frame(&mut self.stream)?;
        let val: serde_json::Value = serde_json::from_slice(&frame)?;
        if val["type"] == "AuthenticateResponse" {
            Ok(val["payload"]["authenticated"] == true)
        } else {
            Ok(false)
        }
    }

    pub fn hello(
        &mut self,
        extension_version: &str,
        protocol_version: u32,
    ) -> Result<HelloResponse, FramingError> {
        let req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "hello-init".to_string(),
            msg_type: "Hello".to_string(),
            payload: serde_json::to_value(HelloRequest {
                extension_version: extension_version.to_string(),
                protocol_version,
            })?,
        };
        write_message(&mut self.stream, &req)?;
        let resp: IpcResponse = read_message(&mut self.stream)?;
        let hello_resp: HelloResponse = serde_json::from_value(resp.payload)?;
        Ok(hello_resp)
    }

    pub fn health(&mut self) -> Result<HealthResponse, FramingError> {
        let req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "health-init".to_string(),
            msg_type: "Health".to_string(),
            payload: serde_json::to_value(HealthRequest {})?,
        };
        write_message(&mut self.stream, &req)?;
        let resp: IpcResponse = read_message(&mut self.stream)?;
        let health_resp: HealthResponse = serde_json::from_value(resp.payload)?;
        Ok(health_resp)
    }

    pub fn evaluate_ai_access(
        &mut self,
        service_id: &str,
        mode: AiAccessMode,
    ) -> Result<EvaluateAiAccessResponse, FramingError> {
        let req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "eval-init".to_string(),
            msg_type: "EvaluateAiAccess".to_string(),
            payload: serde_json::to_value(EvaluateAiAccessRequest {
                service_id: service_id.to_string(),
                mode,
            })?,
        };
        write_message(&mut self.stream, &req)?;
        let resp: IpcResponse = read_message(&mut self.stream)?;
        let eval_resp: EvaluateAiAccessResponse = serde_json::from_value(resp.payload)?;
        Ok(eval_resp)
    }

    pub fn inspect(
        &mut self,
        source: &str,
        ai_service: &str,
        content: &str,
    ) -> Result<InspectResponse, FramingError> {
        let req = IpcRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "inspect-init".to_string(),
            msg_type: "Inspect".to_string(),
            payload: serde_json::to_value(InspectRequest {
                source: source.to_string(),
                ai_service: ai_service.to_string(),
                content: content.to_string(),
                timestamp: 1728691200000,
            })?,
        };
        write_message(&mut self.stream, &req)?;
        let resp: IpcResponse = read_message(&mut self.stream)?;
        let inspect_resp: InspectResponse = serde_json::from_value(resp.payload)?;
        Ok(inspect_resp)
    }

    pub fn send_request(&mut self, req: &IpcRequest) -> Result<(), FramingError> {
        write_message(&mut self.stream, req)
    }

    pub fn read_response(&mut self) -> Result<IpcResponse, FramingError> {
        read_message(&mut self.stream)
    }
}
