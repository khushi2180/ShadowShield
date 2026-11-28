use std::env;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use super::sys;

/// Returns the canonical default runtime directory for ShadowShield V2:
/// `~/Library/Application Support/ShadowShield/run/` on macOS.
pub fn default_runtime_dir() -> PathBuf {
    if let Ok(dir) = env::var("SHADOWSHIELD_RUNTIME_DIR") {
        PathBuf::from(dir)
    } else if let Ok(home) = env::var("HOME") {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("ShadowShield")
            .join("run")
    } else {
        let uid = sys::current_uid();
        PathBuf::from("/tmp")
            .join(format!("shadowshield-{}", uid))
            .join("run")
    }
}

/// Verifies that no component in the path hierarchy is an unauthorized symbolic link
/// and that all components are owned either by root (UID 0) or the expected user UID.
pub fn verify_path_hierarchy_secure(target: &Path, expected_uid: u32) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in target.components() {
        current.push(component);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)?;
            if metadata.file_type().is_symlink() {
                // On macOS, Apple mounts standard root aliases (/var -> private/var, /tmp -> private/tmp)
                #[cfg(target_os = "macos")]
                {
                    let p_str = current.to_string_lossy();
                    if p_str == "/var" || p_str == "/tmp" || p_str == "/etc" {
                        continue;
                    }
                }

                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "Path component {:?} is a symbolic link (symlinks strictly prohibited)",
                        current
                    ),
                ));
            }

            let uid = metadata.uid();
            if uid != 0 && uid != expected_uid {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "Path component {:?} owned by untrusted UID {} (expected {})",
                        current, uid, expected_uid
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Sets up the private runtime directory with strict `0700` (`drwx------`) permissions.
pub fn setup_runtime_dir(dir: &Path) -> io::Result<()> {
    let uid = sys::current_uid();
    verify_path_hierarchy_secure(dir, uid)?;

    if !dir.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder.recursive(true);
        builder.create(dir)?;
    }

    let metadata = fs::symlink_metadata(dir)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Runtime directory {:?} is a symlink", dir),
        ));
    }

    fs::set_permissions(dir, Permissions::from_mode(0o700))?;
    Ok(())
}

/// Advisory single-instance process lock on `agent.lock`.
#[derive(Debug)]
pub struct SingleInstanceLock {
    file: File,
    path: PathBuf,
}

impl SingleInstanceLock {
    /// Attempts to acquire an exclusive, non-blocking lock on `<runtime_dir>/agent.lock`.
    pub fn acquire(runtime_dir: &Path) -> io::Result<Self> {
        let lock_path = runtime_dir.join("agent.lock");

        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .open(&lock_path)?;

        match sys::file_lock(&file, sys::LOCK_EX | sys::LOCK_NB) {
            Ok(()) => Ok(Self {
                file,
                path: lock_path,
            }),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.raw_os_error() == Some(35) => {
                Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!(
                        "Another ShadowShield agent instance is already running (locked {:?})",
                        lock_path
                    ),
                ))
            }
            Err(e) => Err(e),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SingleInstanceLock {
    fn drop(&mut self) {
        let _ = sys::file_lock(&self.file, sys::LOCK_UN);
    }
}

/// Recovers from stale socket files (e.g. following an ungraceful crash) and binds a new UnixListener.
pub fn recover_stale_socket_and_bind(socket_path: &Path) -> io::Result<UnixListener> {
    if socket_path.exists() {
        // Probe connectivity to see if another process is actually alive
        match UnixStream::connect(socket_path) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!(
                        "Active listener already responding on socket {:?}",
                        socket_path
                    ),
                ));
            }
            Err(e) => match e.kind() {
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound => {
                    // Stale socket from previous crash; unlink it safely
                    let _ = fs::remove_file(socket_path);
                }
                _ => {
                    // Other error (e.g. permission or I/O)
                    return Err(e);
                }
            },
        }
    }

    let listener = UnixListener::bind(socket_path)?;
    fs::set_permissions(socket_path, Permissions::from_mode(0o600))?;

    // Verify socket permissions strictly before returning listener to accept clients
    let meta = fs::metadata(socket_path)?;
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o600 {
        let _ = fs::remove_file(socket_path);
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("Socket permissions {:o} do not match required 0600", mode),
        ));
    }

    Ok(listener)
}
