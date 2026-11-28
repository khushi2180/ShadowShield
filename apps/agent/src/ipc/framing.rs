use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::io::{self, Read, Write};
use std::string::FromUtf8Error;
use std::time::{Duration, Instant};

pub const MAX_MESSAGE_SIZE: u32 = 10 * 1024 * 1024; // 10 MiB limit
pub const DEFAULT_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum FramingError {
    Io(io::Error),
    Utf8(FromUtf8Error),
    Json(serde_json::Error),
    MessageTooLarge(u32),
    ConnectionClosed,
    TimedOut,
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {}", e),
            Self::Utf8(e) => write!(f, "UTF-8 error: {}", e),
            Self::Json(e) => write!(f, "JSON error: {}", e),
            Self::MessageTooLarge(size) => {
                write!(
                    f,
                    "Message size {} exceeds maximum {}",
                    size, MAX_MESSAGE_SIZE
                )
            }
            Self::ConnectionClosed => write!(f, "Connection closed by peer"),
            Self::TimedOut => write!(f, "Operation timed out"),
        }
    }
}

impl std::error::Error for FramingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Utf8(e) => Some(e),
            Self::Json(e) => Some(e),
            Self::MessageTooLarge(_) | Self::ConnectionClosed | Self::TimedOut => None,
        }
    }
}

impl From<io::Error> for FramingError {
    fn from(err: io::Error) -> Self {
        if err.kind() == io::ErrorKind::UnexpectedEof {
            Self::ConnectionClosed
        } else if err.kind() == io::ErrorKind::WouldBlock || err.kind() == io::ErrorKind::TimedOut {
            Self::TimedOut
        } else {
            Self::Io(err)
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

/// Reads a 4-byte little-endian length prefix followed by the payload bytes.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, FramingError> {
    let len = match reader.read_u32::<LittleEndian>() {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(FramingError::ConnectionClosed);
        }
        Err(e) => return Err(FramingError::Io(e)),
    };

    if len > MAX_MESSAGE_SIZE {
        return Err(FramingError::MessageTooLarge(len));
    }

    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;
    Ok(buf)
}

/// Reads a length-prefixed frame from a `UnixStream` with an absolute frame reception deadline.
///
/// If `idle_timeout` is provided, waiting for the first byte of the length header is bounded by `idle_timeout`.
/// Once the first byte is received, the deadline is set to `frame_timeout` (further capped by `outer_deadline` if present).
/// The four-byte length header and entire payload must be completely read before the deadline expires.
pub fn read_frame_with_deadlines(
    stream: &mut std::os::unix::net::UnixStream,
    idle_timeout: Option<Duration>,
    frame_timeout: Duration,
    outer_deadline: Option<Instant>,
) -> Result<Vec<u8>, FramingError> {
    let mut header = [0u8; 4];

    // 1. Read first byte of length header
    let mut first_byte = [0u8; 1];
    let wait_limit = match (idle_timeout, outer_deadline) {
        (Some(idle), Some(outer)) => Some(outer.min(Instant::now() + idle)),
        (Some(idle), None) => Some(Instant::now() + idle),
        (None, Some(outer)) => Some(outer),
        (None, None) => None,
    };

    loop {
        if let Some(limit) = wait_limit {
            let now = Instant::now();
            if now >= limit {
                return Err(FramingError::TimedOut);
            }
            let rem = limit - now;
            stream.set_read_timeout(Some(rem))?;
        } else {
            stream.set_read_timeout(None)?;
        }

        match stream.read(&mut first_byte) {
            Ok(0) => return Err(FramingError::ConnectionClosed),
            Ok(1) => break,
            Ok(_) => unreachable!(),
            Err(e)
                if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut =>
            {
                return Err(FramingError::TimedOut);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FramingError::Io(e)),
        }
    }

    header[0] = first_byte[0];

    // 2. Establish absolute frame reception deadline
    let mut frame_deadline = Instant::now() + frame_timeout;
    if let Some(outer) = outer_deadline {
        frame_deadline = frame_deadline.min(outer);
    }

    // 3. Read remaining 3 bytes of length header
    let mut header_read = 1;
    while header_read < 4 {
        let now = Instant::now();
        if now >= frame_deadline {
            return Err(FramingError::TimedOut);
        }
        let rem = frame_deadline - now;
        stream.set_read_timeout(Some(rem))?;
        match stream.read(&mut header[header_read..]) {
            Ok(0) => return Err(FramingError::ConnectionClosed),
            Ok(n) => header_read += n,
            Err(e)
                if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut =>
            {
                return Err(FramingError::TimedOut);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FramingError::Io(e)),
        }
    }

    let len = u32::from_le_bytes(header);
    if len > MAX_MESSAGE_SIZE {
        return Err(FramingError::MessageTooLarge(len));
    }

    // 4. Read payload bytes with the same frame_deadline
    let mut buf = vec![0u8; len as usize];
    let mut payload_read = 0;
    while payload_read < len as usize {
        let now = Instant::now();
        if now >= frame_deadline {
            return Err(FramingError::TimedOut);
        }
        let rem = frame_deadline - now;
        stream.set_read_timeout(Some(rem))?;
        match stream.read(&mut buf[payload_read..]) {
            Ok(0) => return Err(FramingError::ConnectionClosed),
            Ok(n) => payload_read += n,
            Err(e)
                if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut =>
            {
                return Err(FramingError::TimedOut);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FramingError::Io(e)),
        }
    }

    Ok(buf)
}

/// Reads a message from a `UnixStream` with absolute deadlines and parses it as a JSON type `T`.
pub fn read_message_with_deadlines<T: DeserializeOwned>(
    stream: &mut std::os::unix::net::UnixStream,
    idle_timeout: Option<Duration>,
    frame_timeout: Duration,
    outer_deadline: Option<Instant>,
) -> Result<T, FramingError> {
    let bytes = read_frame_with_deadlines(stream, idle_timeout, frame_timeout, outer_deadline)?;
    let string = String::from_utf8(bytes)?;
    let msg = serde_json::from_str(&string)?;
    Ok(msg)
}

/// Writes a 4-byte little-endian length prefix followed by the payload bytes and flushes.
pub fn write_frame<W: Write>(writer: &mut W, data: &[u8]) -> Result<(), FramingError> {
    if data.len() > MAX_MESSAGE_SIZE as usize {
        return Err(FramingError::MessageTooLarge(data.len() as u32));
    }

    writer.write_u32::<LittleEndian>(data.len() as u32)?;
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

/// Reads a length-prefixed frame and parses it as a JSON type `T`.
pub fn read_message<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, FramingError> {
    let bytes = read_frame(reader)?;
    let string = String::from_utf8(bytes)?;
    let msg = serde_json::from_str(&string)?;
    Ok(msg)
}

/// Serializes `msg` to JSON and writes it as a length-prefixed frame.
pub fn write_message<W: Write, T: Serialize>(writer: &mut W, msg: &T) -> Result<(), FramingError> {
    let json_string = serde_json::to_string(msg)?;
    write_frame(writer, json_string.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::io::Cursor;

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct SampleMessage {
        id: String,
        count: u32,
    }

    #[test]
    fn test_framing_roundtrip() {
        let msg = SampleMessage {
            id: "test-roundtrip".to_string(),
            count: 42,
        };

        let mut buf = Vec::new();
        write_message(&mut buf, &msg).expect("write message");

        let mut reader = Cursor::new(buf);
        let parsed: SampleMessage = read_message(&mut reader).expect("read message");
        assert_eq!(msg, parsed);
    }

    #[test]
    fn test_oversized_declared_length_rejected() {
        let mut buf = Vec::new();
        // Declare length larger than 10 MiB
        buf.write_u32::<LittleEndian>(MAX_MESSAGE_SIZE + 1).unwrap();
        let mut reader = Cursor::new(buf);

        let res = read_frame(&mut reader);
        match res {
            Err(FramingError::MessageTooLarge(size)) => {
                assert_eq!(size, MAX_MESSAGE_SIZE + 1);
            }
            other => panic!("Expected MessageTooLarge, got: {:?}", other),
        }
    }

    #[test]
    fn test_unexpected_eof_on_length() {
        let mut reader = Cursor::new(vec![0u8; 2]); // only 2 bytes instead of 4
        match read_frame(&mut reader) {
            Err(FramingError::ConnectionClosed) => (),
            other => panic!("Expected ConnectionClosed, got: {:?}", other),
        }
    }
}
