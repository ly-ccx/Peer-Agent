//! Stop only a fully recorded, matching child group. The caller has already
//! proved the original owner dead. This observes local lifetime, never effects.
use super::*;
use crate::CancellationToken;
use std::time::Duration;

pub(crate) async fn stop_recorded_group(
    owner: &Recorder,
    child: &Recorder,
    cancel: &CancellationToken,
) -> bool {
    if cancel.is_cancelled()
        || !owner.complete()
        || !child.complete()
        || child.boot_id != owner.boot_id
        || child.host_id != owner.host_id
        || child.acquired_at != owner.acquired_at
    {
        return false;
    }
    // This probe owns its actual OS subprocesses through completion. Do not
    // drop it via an outer timeout/select and call that a completed observation.
    let proof = prove(child).await;
    if cancel.is_cancelled() {
        return false;
    }
    if proof == RecorderProof::Alive {
        let Some(pid) = rustix::process::Pid::from_raw(child.pid as i32) else {
            return false;
        };
        if rustix::process::getpgid(Some(pid)).ok() != Some(pid)
            || rustix::process::kill_process_group(pid, rustix::process::Signal::KILL).is_err()
        {
            return false;
        }
        // Once signalled, finish the actual bounded group observation even if
        // cancellation arrives. Cancellation is not a substitute for absence.
        for _ in 0..20 {
            if group_absent(child.pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    } else if !proof.allows_settlement() {
        return false;
    }
    group_absent(child.pid)
}
