//! OS observations of the complete recording-process tuple. Missing runtime
//! tokens, a bare PID, permission errors and a failed query are never death proof.
use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use std::io::Read;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorder {
    pub boot_id: String,
    pub pid: u32,
    pub pid_start: String,
    pub host_id: String,
    pub acquired_at: String,
}
impl Recorder {
    pub fn complete(&self) -> bool {
        self.pid > 0
            && self.pid <= i32::MAX as u32
            && [
                &self.boot_id,
                &self.pid_start,
                &self.host_id,
                &self.acquired_at,
            ]
            .into_iter()
            .all(|s| !s.is_empty() && s.len() <= 8192)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecorderProof {
    Alive,
    Dead,
    Reused,
    DifferentBoot,
    Unproven,
}
impl RecorderProof {
    pub fn allows_settlement(self) -> bool {
        matches!(self, Self::Dead | Self::Reused | Self::DifferentBoot)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alive => "alive",
            Self::Dead => "dead",
            Self::Reused => "reused",
            Self::DifferentBoot => "different_boot",
            Self::Unproven => "unproven",
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum ProcessStart {
    Present(String),
    Absent,
    Unavailable,
}
pub struct RecorderObservation {
    pub boot_before: Option<String>,
    pub process: ProcessStart,
    pub boot_after: Option<String>,
}
/// Pure proof classifier over an actual host observation. A failed observation
/// is distinct from an observed missing process; boot changes during probing fail.
pub fn classify(recorded: &Recorder, observed: &RecorderObservation) -> RecorderProof {
    if !recorded.complete() {
        return RecorderProof::Unproven;
    }
    let Some(boot) = observed.boot_before.as_deref().filter(|s| !s.is_empty()) else {
        return RecorderProof::Unproven;
    };
    if observed.boot_after.as_deref() != Some(boot) {
        return RecorderProof::Unproven;
    }
    if boot != recorded.boot_id {
        return RecorderProof::DifferentBoot;
    }
    match &observed.process {
        ProcessStart::Present(start) if start == &recorded.pid_start => RecorderProof::Alive,
        ProcessStart::Present(start) if !start.is_empty() => RecorderProof::Reused,
        ProcessStart::Absent => RecorderProof::Dead,
        _ => RecorderProof::Unproven,
    }
}
#[cfg(target_os = "linux")]
fn bounded_file(path: &std::path::Path) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(8193)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    String::from_utf8(bytes).ok()
}
#[cfg(target_os = "macos")]
async fn command(path: &str, args: &[&str]) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let read = async {
        let mut bytes = Vec::new();
        (&mut stdout)
            .take(8193)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() > 8192 || !child.wait().await.ok()?.success() {
            return None;
        }
        String::from_utf8(bytes).ok()
    };
    match tokio::time::timeout(std::time::Duration::from_secs(2), read).await {
        Ok(Some(result)) => Some(result),
        Ok(None) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    }
}
async fn boot_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        bounded_file(std::path::Path::new("/proc/sys/kernel/random/boot_id"))
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "macos")]
    {
        let s = command("/usr/sbin/sysctl", &["-n", "kern.boottime"]).await?;
        let sec = s
            .split("sec = ")
            .nth(1)?
            .split(',')
            .next()?
            .trim()
            .parse::<u64>()
            .ok()?;
        let usec = s
            .split("usec = ")
            .nth(1)?
            .split('}')
            .next()?
            .trim()
            .parse::<u64>()
            .ok()?;
        Some(format!("boottime:{sec}.{usec}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}
fn confirmed_absent(pid: u32) -> bool {
    rustix::process::Pid::from_raw(pid as i32)
        .is_some_and(|pid| rustix::process::test_kill_process(pid) == Err(rustix::io::Errno::SRCH))
}
async fn process_start(pid: u32) -> ProcessStart {
    if pid == 0 || pid > i32::MAX as u32 {
        return ProcessStart::Unavailable;
    }
    #[cfg(target_os = "linux")]
    {
        let path = std::path::PathBuf::from(format!("/proc/{pid}/stat"));
        match bounded_file(&path) {
            Some(s) => s
                .rsplit_once(')')
                .and_then(|(_, tail)| tail.split_whitespace().nth(19))
                .filter(|s| s.bytes().all(|b| b.is_ascii_digit()))
                .map(|s| ProcessStart::Present(format!("linux:{s}")))
                .unwrap_or(ProcessStart::Unavailable),
            None if confirmed_absent(pid) => ProcessStart::Absent,
            None => ProcessStart::Unavailable,
        }
    }
    #[cfg(target_os = "macos")]
    {
        match command("/bin/ps", &["-o", "lstart=", "-p", &pid.to_string()]).await {
            Some(s) if !s.trim().is_empty() => ProcessStart::Present(format!("macos:{}", s.trim())),
            _ if confirmed_absent(pid) => ProcessStart::Absent,
            _ => ProcessStart::Unavailable,
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        ProcessStart::Unavailable
    }
}
pub async fn local_recorder(host_id: &str, acquired_at: &str) -> Option<Recorder> {
    let boot = boot_id().await?;
    let pid = std::process::id();
    let ProcessStart::Present(pid_start) = process_start(pid).await else {
        return None;
    };
    if boot_id().await.as_deref() != Some(boot.as_str()) {
        return None;
    }
    let recorder = Recorder {
        boot_id: boot,
        pid,
        pid_start,
        host_id: host_id.into(),
        acquired_at: acquired_at.into(),
    };
    recorder.complete().then_some(recorder)
}
pub async fn prove(recorded: &Recorder) -> RecorderProof {
    if !recorded.complete() {
        return RecorderProof::Unproven;
    }
    let before = boot_id().await;
    let process = process_start(recorded.pid).await;
    classify(
        recorded,
        &RecorderObservation {
            boot_before: before,
            process,
            boot_after: boot_id().await,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absence_requires_complete_tuple_and_available_stable_boot() {
        let r = Recorder {
            boot_id: "boot".into(),
            pid: 123,
            pid_start: "start".into(),
            host_id: "host".into(),
            acquired_at: "at".into(),
        };
        let observe = |boot: Option<&str>, process| RecorderObservation {
            boot_before: boot.map(str::to_owned),
            boot_after: boot.map(str::to_owned),
            process,
        };
        assert_eq!(
            classify(
                &r,
                &observe(Some("boot"), ProcessStart::Present("start".into()))
            ),
            RecorderProof::Alive
        );
        assert_eq!(
            classify(
                &r,
                &observe(Some("boot"), ProcessStart::Present("other".into()))
            ),
            RecorderProof::Reused
        );
        assert_eq!(
            classify(&r, &observe(Some("other"), ProcessStart::Unavailable)),
            RecorderProof::DifferentBoot
        );
        assert_eq!(
            classify(&r, &observe(Some("boot"), ProcessStart::Absent)),
            RecorderProof::Dead
        );
        assert_eq!(
            classify(&r, &observe(Some("boot"), ProcessStart::Unavailable)),
            RecorderProof::Unproven
        );
        assert_eq!(
            classify(&r, &observe(None, ProcessStart::Absent)),
            RecorderProof::Unproven
        );
        let mut incomplete = r.clone();
        incomplete.pid_start.clear();
        assert_eq!(
            classify(&incomplete, &observe(Some("boot"), ProcessStart::Absent)),
            RecorderProof::Unproven
        );
        let mut changed = observe(Some("boot"), ProcessStart::Absent);
        changed.boot_after = Some("other".into());
        assert_eq!(classify(&r, &changed), RecorderProof::Unproven);
    }
    #[tokio::test]
    async fn current_os_process_is_live_and_start_mismatch_is_reused() {
        let r = local_recorder("native-test-host", "2026-11-14T04:00:00.000Z")
            .await
            .expect("native recorder observation");
        assert_eq!(prove(&r).await, RecorderProof::Alive);
        let mut changed = r;
        changed.pid_start = "not-the-current-start".into();
        assert_eq!(prove(&changed).await, RecorderProof::Reused);
    }
}
