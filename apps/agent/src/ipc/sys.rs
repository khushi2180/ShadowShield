use std::io;
use std::os::unix::io::AsRawFd;

extern "C" {
    fn getpeereid(
        fildes: std::os::raw::c_int,
        euid: *mut u32,
        egid: *mut u32,
    ) -> std::os::raw::c_int;
    fn geteuid() -> u32;
    fn getuid() -> u32;
    fn flock(fd: std::os::raw::c_int, operation: std::os::raw::c_int) -> std::os::raw::c_int;
    fn pipe(fds: *mut std::os::raw::c_int) -> std::os::raw::c_int;
    fn write(fd: std::os::raw::c_int, buf: *const std::os::raw::c_void, count: usize) -> isize;
    fn read(fd: std::os::raw::c_int, buf: *mut std::os::raw::c_void, count: usize) -> isize;
    fn close(fd: std::os::raw::c_int) -> std::os::raw::c_int;
    fn signal(sig: std::os::raw::c_int, handler: usize) -> usize;
    fn kill(pid: std::os::raw::c_int, sig: std::os::raw::c_int) -> std::os::raw::c_int;
    fn fcntl(
        fd: std::os::raw::c_int,
        cmd: std::os::raw::c_int,
        arg: std::os::raw::c_int,
    ) -> std::os::raw::c_int;
}

pub const LOCK_EX: std::os::raw::c_int = 2;
pub const LOCK_NB: std::os::raw::c_int = 4;
pub const LOCK_UN: std::os::raw::c_int = 8;

pub const SIGINT: std::os::raw::c_int = 2;
pub const SIGTERM: std::os::raw::c_int = 15;
pub const SIG_DFL: usize = 0;

pub const F_GETFL: std::os::raw::c_int = 3;
pub const F_SETFL: std::os::raw::c_int = 4;
pub const O_NONBLOCK: std::os::raw::c_int = 4;

pub fn create_pipe() -> io::Result<(std::os::raw::c_int, std::os::raw::c_int)> {
    let mut fds = [0 as std::os::raw::c_int; 2];
    let res = unsafe { pipe(fds.as_mut_ptr()) };
    if res == 0 {
        Ok((fds[0], fds[1]))
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn close_fd(fd: std::os::raw::c_int) -> io::Result<()> {
    let res = unsafe { close(fd) };
    if res == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn raw_write(fd: std::os::raw::c_int, buf: &[u8]) -> isize {
    unsafe { write(fd, buf.as_ptr() as *const _, buf.len()) }
}

pub fn raw_read(fd: std::os::raw::c_int, buf: &mut [u8]) -> isize {
    unsafe { read(fd, buf.as_mut_ptr() as *mut _, buf.len()) }
}

pub fn register_signal_handler(
    sig: std::os::raw::c_int,
    handler: extern "C" fn(std::os::raw::c_int),
) {
    unsafe {
        signal(sig, handler as usize);
    }
}

pub fn restore_default_signal_handler(sig: std::os::raw::c_int) {
    unsafe {
        signal(sig, SIG_DFL);
    }
}

pub fn set_nonblocking(fd: std::os::raw::c_int) -> io::Result<()> {
    let flags = unsafe { fcntl(fd, F_GETFL, 0) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    let res = unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) };
    if res < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn send_signal(pid: std::os::raw::c_int, sig: std::os::raw::c_int) -> io::Result<()> {
    let res = unsafe { kill(pid, sig) };
    if res == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn peer_credentials<F: AsRawFd>(fd: &F) -> io::Result<(u32, u32)> {
    let mut euid: u32 = 0;
    let mut egid: u32 = 0;
    let res = unsafe { getpeereid(fd.as_raw_fd(), &mut euid, &mut egid) };
    if res == 0 {
        Ok((euid, egid))
    } else {
        Err(io::Error::last_os_error())
    }
}

pub fn current_euid() -> u32 {
    unsafe { geteuid() }
}

pub fn current_uid() -> u32 {
    unsafe { getuid() }
}

pub fn file_lock<F: AsRawFd>(fd: &F, operation: std::os::raw::c_int) -> io::Result<()> {
    let res = unsafe { flock(fd.as_raw_fd(), operation) };
    if res == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
