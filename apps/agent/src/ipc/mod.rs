pub mod auth;
pub mod client;
pub mod framing;
pub mod server;
pub mod signal;
pub mod sys;
pub mod transport;

pub use client::IpcClient;
pub use framing::{
    read_frame, read_frame_with_deadlines, read_message, read_message_with_deadlines, write_frame,
    write_message, FramingError, DEFAULT_FRAME_TIMEOUT, MAX_MESSAGE_SIZE,
};
pub use server::{IpcServer, IpcServerConfig, ShutdownHandle};
pub use signal::install_signal_handler;
pub use transport::{default_runtime_dir, SingleInstanceLock};
