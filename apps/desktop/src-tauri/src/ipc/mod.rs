pub mod client;
pub mod framing;
pub mod protocol;

pub use client::{IpcHealthClient, IpcPaths, IpcStream, IpcTransport, default_runtime_dir};
pub use framing::{read_frame, read_message, write_frame, write_message, FramingError, MAX_FRAME_LENGTH};
pub use protocol::{
    AuthenticateRequest, AuthenticateResponse, HealthRequest, HealthResponse, HelloRequest,
    HelloResponse, IpcErrorPayload, IpcErrorResponse, IpcRequest, IpcResponse,
    SanitizedHealthStatus, TokenSecret, TrayHealthState, PROTOCOL_VERSION, UNMONITORED_LABEL,
};
