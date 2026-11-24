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
}

pub const LOCK_EX: std::os::raw::c_int = 2;
pub const LOCK_NB: std::os::raw::c_int = 4;
pub const LOCK_UN: std::os::raw::c_int = 8;

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
