//! Fixed OS configuration queries; no model-controlled program or arguments.
use super::*;
#[cfg(any(target_os = "macos", test))]
use std::time::Duration;
#[cfg(any(target_os = "macos", test))]
pub(super) fn parse_proxy(output: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric()) && !value.is_empty() {
            fields.insert(key, value);
        }
    }
    let mut result = BTreeMap::new();
    for (protocol, prefix) in [("http", "HTTP"), ("https", "HTTPS")] {
        if fields.get(format!("{prefix}Enable").as_str()) != Some(&"1") {
            continue;
        }
        let Some(host) = fields
            .get(format!("{prefix}Proxy").as_str())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let port = fields
            .get(format!("{prefix}Port").as_str())
            .filter(|v| !v.is_empty());
        result.insert(
            protocol.into(),
            format!(
                "http://{host}{}",
                port.map(|p| format!(":{p}")).unwrap_or_default()
            ),
        );
    }
    result
}
#[cfg(any(target_os = "macos", test))]
async fn query(
    binary: &str,
    args: &[&std::ffi::OsStr],
    limit: u64,
    cancel: &CancellationToken,
) -> Result<Option<String>, Error> {
    use tokio::io::AsyncReadExt;
    if cancel.is_cancelled() {
        return Err(Error("CANCELLED"));
    }
    let mut child = match tokio::process::Command::new(binary)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Ok(None),
    };
    let stdout = child
        .stdout
        .take()
        .ok_or(Error("network_system_query_unavailable"))?;
    let operation = async {
        let mut bytes = vec![];
        stdout.take(limit + 1).read_to_end(&mut bytes).await.ok()?;
        if bytes.len() as u64 > limit || !child.wait().await.ok()?.success() {
            return None;
        }
        String::from_utf8(bytes).ok()
    };
    let result = tokio::select! {biased;
        _=cancel.cancelled()=>Err(Error("CANCELLED")),
        value=tokio::time::timeout(Duration::from_secs(2),operation)=>Ok(value.unwrap_or_default()),
    };
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.start_kill();
        if !matches!(
            tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
            Ok(Ok(_))
        ) {
            return Err(Error("network_system_cleanup_unknown"));
        }
    }
    result
}
pub(super) async fn proxy(cancel: &CancellationToken) -> Result<BTreeMap<String, String>, Error> {
    #[cfg(target_os = "macos")]
    {
        let output = query(
            "/usr/sbin/scutil",
            &[std::ffi::OsStr::new("--proxy")],
            65536,
            cancel,
        )
        .await?;
        Ok(output.as_deref().map(parse_proxy).unwrap_or_default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cancel;
        Ok(BTreeMap::new())
    }
}
pub(super) async fn roots(cancel: &CancellationToken) -> Result<&'static [Root], Error> {
    #[cfg(target_os = "macos")]
    {
        static ROOTS: tokio::sync::OnceCell<Vec<Root>> = tokio::sync::OnceCell::const_new();
        ROOTS
            .get_or_try_init(|| load_roots(cancel))
            .await
            .map(Vec::as_slice)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cancel;
        Ok(&[])
    }
}
#[cfg(target_os = "macos")]
async fn load_roots(cancel: &CancellationToken) -> Result<Vec<Root>, Error> {
    use std::ffi::OsStr;
    let directory = match tempfile::tempdir() {
        Ok(value) => value,
        Err(_) => return Ok(vec![]),
    };
    let mut fingerprints = std::collections::BTreeSet::new();
    for domain in ["user", "admin"] {
        let path = directory.path().join(format!("{domain}.plist"));
        let args: Vec<&OsStr> = if domain == "admin" {
            vec![
                OsStr::new("trust-settings-export"),
                OsStr::new("-d"),
                path.as_os_str(),
            ]
        } else {
            vec![OsStr::new("trust-settings-export"), path.as_os_str()]
        };
        if query("/usr/bin/security", &args, 65536, cancel)
            .await?
            .is_none()
        {
            continue;
        }
        let args = [
            OsStr::new("-extract"),
            OsStr::new("trustList"),
            OsStr::new("xml1"),
            OsStr::new("-o"),
            OsStr::new("-"),
            path.as_os_str(),
        ];
        if let Some(xml) = query("/usr/bin/plutil", &args, 524288, cancel).await? {
            fingerprints.extend(trust::fingerprints(&xml));
        }
    }
    if fingerprints.is_empty() {
        return Ok(vec![]);
    }
    let args = [
        OsStr::new("find-certificate"),
        OsStr::new("-a"),
        OsStr::new("-p"),
    ];
    let Some(pem) = query("/usr/bin/security", &args, 2097152, cancel).await? else {
        return Ok(vec![]);
    };
    Ok(trust::selected(&pem, &fingerprints)
        .into_iter()
        .map(|(_, cert)| cert)
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn os_proxy_and_trust_selection_match_actual_ts() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/network.json"
        ))
        .unwrap();
        for case in data["system"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(parse_proxy(case["raw"].as_str().unwrap())).unwrap(),
                case["expected"]
            );
        }
        for case in data["trust"].as_array().unwrap() {
            let keys = trust::fingerprints(case["xml"].as_str().unwrap());
            let actual: Vec<_> = trust::selected(case["pem"].as_str().unwrap(), &keys)
                .into_iter()
                .map(|(pem, _)| pem)
                .collect();
            assert_eq!(serde_json::to_value(actual).unwrap(), case["expected"]);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_query_cancellation_and_output_exhaustion_reap_the_owned_process() {
        use std::ffi::OsStr;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pid");
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let action = async {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !path.exists() {
                    tokio::task::yield_now().await;
                }
                trigger.cancel();
            })
            .await
            .expect("owned query must start before cancellation");
        };
        let args = [
            OsStr::new("-c"),
            OsStr::new("echo $$ > \"$1.tmp\"; /bin/mv \"$1.tmp\" \"$1\"; exec sleep 20"),
            OsStr::new("fixture"),
            path.as_os_str(),
        ];
        let (result, _) = tokio::join!(query("/bin/sh", &args, 128, &cancel), action);
        assert_eq!(result, Err(Error("CANCELLED")));
        let pid = std::fs::read_to_string(&path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert!(
            rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid).unwrap())
                .is_err()
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            query("/bin/sh", &args, 128, &CancellationToken::new())
                .await
                .unwrap(),
            None
        );
        let pid = std::fs::read_to_string(&path)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert!(
            rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid).unwrap())
                .is_err()
        );
        assert_eq!(
            query(
                "/bin/sh",
                &[OsStr::new("-c"), OsStr::new("printf 'too large'")],
                2,
                &CancellationToken::new()
            )
            .await
            .unwrap(),
            None
        );
        assert_eq!(
            query(
                "/bin/sh",
                &[OsStr::new("-c"), OsStr::new("printf ready")],
                32,
                &CancellationToken::new()
            )
            .await
            .unwrap()
            .as_deref(),
            Some("ready")
        );
    }
}
