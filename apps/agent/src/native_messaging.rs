use byteorder::{LittleEndian, ReadBytesExt, WriteBytesExt};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::string::FromUtf8Error;

const MAX_MESSAGE_SIZE: u32 = 10 * 1024 * 1024; // 10MB limit

#[derive(Debug)]
#[allow(dead_code)]
pub enum NativeMessagingError {
    Io(io::Error),
    Utf8(FromUtf8Error),
    Json(serde_json::Error),
    MessageTooLarge(u32),
}

impl From<io::Error> for NativeMessagingError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}
impl From<FromUtf8Error> for NativeMessagingError {
    fn from(err: FromUtf8Error) -> Self {
        Self::Utf8(err)
    }
}
impl From<serde_json::Error> for NativeMessagingError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

pub fn read_message<R: Read, T: for<'de> Deserialize<'de>>(
    mut reader: R,
) -> Result<Option<T>, NativeMessagingError> {
    let len = match reader.read_u32::<LittleEndian>() {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(NativeMessagingError::Io(e)),
    };

    if len > MAX_MESSAGE_SIZE {
        return Err(NativeMessagingError::MessageTooLarge(len));
    }

    let mut buf = vec![0; len as usize];
    reader
        .read_exact(&mut buf)
        .map_err(NativeMessagingError::Io)?;

    let msg_str = String::from_utf8(buf).map_err(NativeMessagingError::Utf8)?;
    let msg: T = serde_json::from_str(&msg_str).map_err(NativeMessagingError::Json)?;

    Ok(Some(msg))
}

pub fn write_message<W: Write, T: Serialize>(
    mut writer: W,
    message: &T,
) -> Result<(), NativeMessagingError> {
    let msg_str = serde_json::to_string(message).map_err(NativeMessagingError::Json)?;
    let len = msg_str.len() as u32;

    writer
        .write_u32::<LittleEndian>(len)
        .map_err(NativeMessagingError::Io)?;
    writer
        .write_all(msg_str.as_bytes())
        .map_err(NativeMessagingError::Io)?;
    writer.flush().map_err(NativeMessagingError::Io)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::io::Cursor;

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct DummyMessage {
        hello: String,
    }

    #[test]
    fn test_valid_frame_roundtrip() {
        let msg = DummyMessage {
            hello: "world".to_string(),
        };
        let mut buf = Vec::new();

        write_message(&mut buf, &msg).unwrap();

        let mut reader = Cursor::new(buf);
        let parsed: DummyMessage = read_message(&mut reader).unwrap().unwrap();

        assert_eq!(msg, parsed);
    }

    #[test]
    fn test_multiple_sequential_frames() {
        let msg1 = DummyMessage {
            hello: "one".to_string(),
        };
        let msg2 = DummyMessage {
            hello: "two".to_string(),
        };

        let mut buf = Vec::new();
        write_message(&mut buf, &msg1).unwrap();
        write_message(&mut buf, &msg2).unwrap();

        let mut reader = Cursor::new(buf);
        let parsed1: DummyMessage = read_message(&mut reader).unwrap().unwrap();
        let parsed2: DummyMessage = read_message(&mut reader).unwrap().unwrap();

        assert_eq!(msg1, parsed1);
        assert_eq!(msg2, parsed2);
    }

    #[test]
    fn test_eof_handling() {
        let buf = Vec::new(); // Empty input
        let mut reader = Cursor::new(buf);

        let result: Option<DummyMessage> = read_message(&mut reader).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_oversized_declared_length() {
        let mut buf = Vec::new();
        // Manually write oversized length
        buf.write_u32::<LittleEndian>(MAX_MESSAGE_SIZE + 1).unwrap();

        let mut reader = Cursor::new(buf);
        let err = read_message::<_, DummyMessage>(&mut reader).unwrap_err();
        assert!(matches!(err, NativeMessagingError::MessageTooLarge(_)));
    }

    #[test]
    fn test_truncated_payload() {
        let mut buf = Vec::new();
        let msg = DummyMessage {
            hello: "world".to_string(),
        };
        write_message(&mut buf, &msg).unwrap();

        // Remove the last byte
        buf.pop();

        let mut reader = Cursor::new(buf);
        let err = read_message::<_, DummyMessage>(&mut reader).unwrap_err();
        assert!(matches!(err, NativeMessagingError::Io(_))); // Unexpected EOF
    }

    #[test]
    fn test_malformed_json() {
        let mut buf = Vec::new();
        let bad_json = b"{ \"hello\": \"world\" "; // missing closing brace
        buf.write_u32::<LittleEndian>(bad_json.len() as u32)
            .unwrap();
        buf.write_all(bad_json).unwrap();
        let mut reader = Cursor::new(buf);
        let err = read_message::<_, DummyMessage>(&mut reader).unwrap_err();
        assert!(matches!(err, NativeMessagingError::Json(_)));
    }
}
