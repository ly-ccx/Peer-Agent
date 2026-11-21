//! Stable kernel process start identity. Display dates are never PID proof.
use super::ProcessStart;
pub(super) fn process_start(pid: u32) -> ProcessStart {
    // PROC_PIDTBSDINFO's nonzero arg includes exited, not-yet-reaped children.
    // They retain a real kernel birth time; status alone never proves a stop.
    match libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(pid as i32, 1) {
        Ok(info)
            if info.pbi_pid == pid
                && info.pbi_start_tvsec > 0
                && info.pbi_start_tvusec < 1_000_000 =>
        {
            ProcessStart::Present(format!(
                "macos-v2:{}:{}",
                info.pbi_start_tvsec, info.pbi_start_tvusec
            ))
        }
        _ if super::confirmed_absent(pid) => ProcessStart::Absent,
        _ => ProcessStart::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn exited_unreaped_owned_child_keeps_its_real_kernel_start_until_actual_wait() {
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = child.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let observed = loop {
            if let Ok(info)=libproc::proc_pid::pidinfo::<libproc::bsd_info::BSDInfo>(pid as i32,1)
                // Darwin sys/proc.h SZOMB. This is readiness for the test, not
                // a production death proof or a substitute for Child::wait.
                && info.pbi_status==5
            {
                break Some(info);
            }
            if std::time::Instant::now() >= deadline {
                break None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        };
        let recorded =
            crate::recorder::process_recorder(pid, "owned-fast-child", "2026-11-18T00:00:00Z")
                .await;
        if observed.is_none() {
            let _ = child.kill();
        }
        let waited = child.wait().unwrap();
        let observed = observed.expect("actual unreaped zombie readiness");
        assert!(waited.success());
        let recorded =
            recorded.expect("a real owned unreaped child still has a precise start identity");
        assert_eq!(recorded.pid, pid);
        assert_eq!(
            recorded.pid_start,
            format!(
                "macos-v2:{}:{}",
                observed.pbi_start_tvsec, observed.pbi_start_tvusec
            )
        );
    }
}
