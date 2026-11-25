pub mod auth;
pub mod client;
pub mod framing;
pub mod server;
pub mod sys;
pub mod transport;

pub use client::IpcClient;
pub use framing::{
    read_frame, read_message, write_frame, write_message, FramingError, MAX_MESSAGE_SIZE,
};
pub use server::{IpcServer, IpcServerConfig, ShutdownHandle};
pub use transport::{default_runtime_dir, SingleInstanceLock};
