//! Read the actual owned process directory, including its filesystem identity.
//! Shell variable PWD and printed text do not prove this scope.
use std::{fs, os::unix::fs::MetadataExt, path::PathBuf};

#[cfg(target_os = "linux")]
pub(super) fn observe(pid: u32) -> Option<PathBuf> {
    let link = PathBuf::from(format!("/proc/{pid}/cwd"));
    let path = fs::read_link(&link).ok()?;
    let target = fs::metadata(&link).ok()?;
    let named = fs::metadata(&path).ok()?;
    (path.is_absolute()
        && named.is_dir()
        && target.dev() == named.dev()
        && target.ino() == named.ino())
    .then_some(path)
}

#[cfg(target_os = "macos")]
pub(super) fn observe(pid: u32) -> Option<PathBuf> {
    use libproc::libproc::proc_pid::{PIDInfo, PidInfoFlavor, pidinfo};
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    #[repr(transparent)]
    struct VnodePathInfo(libc::proc_vnodepathinfo);
    impl PIDInfo for VnodePathInfo {
        fn flavor() -> PidInfoFlavor {
            PidInfoFlavor::VNodePathInfo
        }
    }
    let pid = i32::try_from(pid).ok()?;
    let dir = pidinfo::<VnodePathInfo>(pid, 0).ok()?.0.pvi_cdir;
    let bytes = dir.vip_path.as_flattened();
    let end = bytes.iter().position(|&c| c == 0)?;
    let path = PathBuf::from(OsString::from_vec(
        bytes[..end].iter().map(|&c| c as u8).collect(),
    ));
    let named = fs::metadata(&path).ok()?;
    let expected = dir.vip_vi.vi_stat;
    (path.is_absolute()
        && named.is_dir()
        && named.dev() == u64::from(expected.vst_dev)
        && named.ino() == expected.vst_ino)
        .then_some(path)
}
