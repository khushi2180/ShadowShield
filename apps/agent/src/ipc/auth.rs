use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::Path;

use super::sys;

/// Generates 32 cryptographically secure random bytes from `/dev/urandom`
/// and formats them as a 64-character lowercase hex string.
pub fn generate_token() -> io::Result<String> {
    let mut file = fs::File::open("/dev/urandom")?;
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)?;

    let mut hex = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{:02x}", b);
    }
    Ok(hex)
}

/// Atomically writes `token` to `path` with strict `0600` (`-rw-------`) permissions.
pub fn write_token_file(path: &Path, token: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }

    let tmp_path = path.with_extension("tmp");

    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)?;

        file.write_all(token.as_bytes())?;
        file.sync_all()?;
    }

    fs::rename(&tmp_path, path)?;

    // Ensure permissions are strictly 0600 on the final target
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(())
}

/// Reads the token from `path` and trims whitespace.
pub fn read_token_file(path: &Path) -> io::Result<String> {
    let content = fs::read_to_string(path)?;
    Ok(content.trim().to_string())
}

/// Constant-time comparison between two byte slices to mitigate timing side channels.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }

    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Verifies that the connecting peer's EUID matches the daemon's effective UID.
pub fn verify_peer_credentials<F: AsRawFd>(fd: &F) -> io::Result<bool> {
    let (peer_euid, _) = sys::peer_credentials(fd)?;
    let daemon_euid = sys::current_euid();
    Ok(peer_euid == daemon_euid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_token_length_and_hex() {
        let token = generate_token().expect("generate token");
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_constant_time_eq() {
        let t1 = "abcdef0123456789";
        let t2 = "abcdef0123456789";
        let t3 = "abcdef0123456780";
        let t4 = "abcdef";

        assert!(constant_time_eq(t1.as_bytes(), t2.as_bytes()));
        assert!(!constant_time_eq(t1.as_bytes(), t3.as_bytes()));
        assert!(!constant_time_eq(t1.as_bytes(), t4.as_bytes()));
    }
}
