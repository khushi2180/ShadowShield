use log::info;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread;

use super::server::ShutdownHandle;
use super::sys;

static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);
static SIGNAL_SENT: AtomicBool = AtomicBool::new(false);
static INSTALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn handle_signal(sig: std::os::raw::c_int) {
    let fd = SIGNAL_WRITE_FD.load(Ordering::SeqCst);
    if fd >= 0 && !SIGNAL_SENT.swap(true, Ordering::SeqCst) {
        let b = sig as u8;
        sys::raw_write(fd, std::slice::from_ref(&b));
    }
}

/// Installs signal handlers for SIGINT and SIGTERM that trigger cooperative shutdown
/// via a self-pipe. The raw signal handler only performs an async-signal-safe `write()`
/// to the non-blocking pipe; a dedicated background thread reads the signal byte and
/// invokes `shutdown_handle.shutdown()`.
pub fn install_signal_handler(shutdown_handle: ShutdownHandle) -> io::Result<()> {
    if INSTALLED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Signal handler already installed",
        ));
    }

    let (read_fd, write_fd) = sys::create_pipe()?;
    if let Err(e) = sys::set_nonblocking(write_fd) {
        let _ = sys::close_fd(read_fd);
        let _ = sys::close_fd(write_fd);
        INSTALLED.store(false, Ordering::SeqCst);
        return Err(e);
    }

    SIGNAL_SENT.store(false, Ordering::SeqCst);
    SIGNAL_WRITE_FD.store(write_fd, Ordering::SeqCst);

    sys::register_signal_handler(sys::SIGINT, handle_signal);
    sys::register_signal_handler(sys::SIGTERM, handle_signal);

    thread::spawn(move || {
        let mut buf = [0u8; 1];
        loop {
            let n = sys::raw_read(read_fd, &mut buf);
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if n > 0 {
                let sig_num = buf[0];
                info!("Received signal {}, initiating graceful shutdown", sig_num);
                shutdown_handle.shutdown();
            }
            break;
        }

        // Teardown: Safely invalidate global write FD BEFORE closing it to prevent FD reuse race
        let old_write_fd = SIGNAL_WRITE_FD.swap(-1, Ordering::SeqCst);
        let _ = sys::close_fd(read_fd);
        if old_write_fd >= 0 {
            let _ = sys::close_fd(old_write_fd);
        }

        // Restore default signal dispositions and release installation gate
        sys::restore_default_signal_handler(sys::SIGINT);
        sys::restore_default_signal_handler(sys::SIGTERM);
        INSTALLED.store(false, Ordering::SeqCst);
    });

    Ok(())
}
