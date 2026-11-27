use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fmt;
use std::io::{self, Read, Write};
use std::string::FromUtf8Error;

/// Maximum frame length enforced by the IPC contract: 10 MiB (10,485,760 bytes).
pub const MAX_FRAME_LENGTH: u32 = 10 * 1024 * 1024;

#[derive(Debug)]
pub enum FramingError {
    Io(io::Error),
    TimedOut,
    Utf8(FromUtf8Error),
    Json(serde_json::Error),
    MessageTooLarge(u32),
    EmptyFrame,
    ConnectionClosed,
}

impl fmt::Display for FramingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "IPC I/O error: {}", e.kind()),
            Self::TimedOut => write!(f, "IPC read/write timed out"),
            Self::Utf8(_) => write!(f, "IPC payload is not valid UTF-8"),
            Self::Json(_) => write!(f, "IPC payload is not valid JSON"),
            Self::MessageTooLarge(size) => {
                write!(f, "IPC frame length {} exceeds 10 MiB limit", size)
            }
            Self::EmptyFrame => write!(f, "IPC frame length is zero"),
            Self::ConnectionClosed => write!(f, "IPC connection closed by peer"),
        }
    }
}

impl std::error::Error for FramingError {}

impl From<io::Error> for FramingError {
    fn from(err: io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::UnexpectedEof => Self::ConnectionClosed,
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => Self::TimedOut,
            _ => Self::Io(err),
        }
    }
}

impl From<FromUtf8Error> for FramingError {
    fn from(err: FromUtf8Error) -> Self {
        Self::Utf8(err)
    }
}

impl From<serde_json::Error> for FramingError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

/// Reads a 4-byte little-endian length prefix, enforces MAX_FRAME_LENGTH before
/// allocating the payload buffer, and reads the exact payload bytes.
pub fn read_frame<R: Read + ?Sized>(reader: &mut R) -> Result<Vec<u8>, FramingError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header);

    if len > MAX_FRAME_LENGTH {
        return Err(FramingError::MessageTooLarge(len));
    }
    if len == 0 {
        return Err(FramingError::EmptyFrame);
    }

    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;
    Ok(buf)
}

/// Writes a 4-byte little-endian length prefix followed by UTF-8 payload bytes.
pub fn write_frame<W: Write + ?Sized>(writer: &mut W, data: &[u8]) -> Result<(), FramingError> {
    if data.len() > MAX_FRAME_LENGTH as usize {
        return Err(FramingError::MessageTooLarge(data.len() as u32));
    }

    let len = data.len() as u32;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

/// Reads a length-prefixed UTF-8 JSON frame and deserializes it into `T`.
pub fn read_message<R: Read + ?Sized, T: DeserializeOwned>(reader: &mut R) -> Result<T, FramingError> {
    let bytes = read_frame(reader)?;
    let text = String::from_utf8(bytes)?;
    let msg = serde_json::from_str(&text)?;
    Ok(msg)
}

/// Serializes `msg` to JSON and writes it as a 4-byte LE length-prefixed frame.
pub fn write_message<W: Write + ?Sized, T: Serialize>(writer: &mut W, msg: &T) -> Result<(), FramingError> {
    let json = serde_json::to_string(msg)?;
    write_frame(writer, json.as_bytes())
}
