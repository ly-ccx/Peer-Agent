//! Stable kernel process start identity. Display dates are never PID proof.
use super::ProcessStart;
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, kill_process_group, waitid};
use std::time::Duration;
use tokio::time::{Instant, sleep_until};

pub(super) async fn finish_group_signal(pid: u32, deadline: Instant) {
    let Some(leader) = Pid::from_raw(pid as i32) else {
        return;
    };
    loop {
        // A Darwin fork already in progress can join the group after the
        // first signal. Wait for the owned leader to finish before retrying,
        // leaving it unreaped so another process cannot reuse its PID.
        match waitid(
            WaitId::Pid(leader),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        ) {
            Ok(Some(_)) => {
                let _ = kill_process_group(leader, Signal::KILL);
                return;
            }
            Ok(None) | Err(rustix::io::Errno::INTR) => {}
            Err(_) => return,
        }
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        sleep_until((now + Duration::from_millis(10)).min(deadline)).await;
    }
}
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
    async fn unreaped_leader_allows_stopping_a_group_member_that_missed_the_first_signal() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("descendant-ready");
        let mut child = tokio::process::Command::new("/bin/sh")
            .args([
                "-c",
                "(/usr/bin/touch descendant-ready; exec /bin/sleep 15) & wait",
            ])
            .current_dir(temp.path())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let delay = super::Duration::from_millis(10);
        let deadline = super::Instant::now() + super::Duration::from_secs(2);
        tokio::time::timeout_at(deadline, async {
            while !marker.exists() {
                tokio::time::sleep(delay).await;
            }
        })
        .await
        .unwrap();

        // Simulate the missed group member with a signal that only kills the
        // leader. The descendant is still alive in the original group.
        child.start_kill().unwrap();
        assert!(!super::super::group_absent(pid));
        let deadline = super::Instant::now() + super::Duration::from_secs(2);
        super::finish_group_signal(pid, deadline).await;
        tokio::time::timeout_at(deadline, child.wait())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout_at(deadline, async {
            while !super::super::group_absent(pid) {
                tokio::time::sleep(delay).await;
            }
        })
        .await
        .unwrap();
    }

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
