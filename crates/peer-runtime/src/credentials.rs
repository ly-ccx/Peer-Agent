//! Native Helper v1 port. The renderer never receives secrets or invokes this.
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const MAX_REQUEST: usize = 512 * 1024;
const MAX_RESPONSE: usize = 1024 * 1024;
const MAX_SECRET: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    InvalidKey,
    InvalidSecret,
    Unavailable,
    Timeout,
    Cancelled,
    Busy,
    ResponseInvalid,
    ResponseLimit,
    HelperRejected,
    SecureStorageUnavailable,
    MasterKeyMissing,
    MasterKeyInvalid,
    VaultUnavailable,
    VaultInvalid,
    VaultAuthenticationFailed,
}
impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidKey => "credential_key_invalid",
            Self::InvalidSecret => "credential_secret_invalid",
            Self::Unavailable => "credential_helper_unavailable",
            Self::Timeout => "credential_helper_timeout",
            Self::Cancelled => "credential_helper_cancelled",
            Self::Busy => "credential_helper_busy",
            Self::ResponseInvalid => "credential_helper_response_invalid",
            Self::ResponseLimit => "credential_helper_response_limit",
            Self::HelperRejected => "credential_helper_failed",
            Self::SecureStorageUnavailable => "secure_storage_unavailable",
            Self::MasterKeyMissing => "vault_master_key_missing",
            Self::MasterKeyInvalid => "vault_master_key_invalid",
            Self::VaultUnavailable => "credential_vault_unavailable",
            Self::VaultInvalid => "credential_vault_invalid",
            Self::VaultAuthenticationFailed => "credential_vault_authentication_failed",
        })
    }
}
impl std::error::Error for CredentialError {}

/// Intentionally has no Debug/Display or implicit conversion to a loggable String.
pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

pub struct HelperClient {
    executable: PathBuf,
    data_home: PathBuf,
    deadline: Duration,
    permits: Semaphore,
}

struct SensitiveJson(Value);
impl Drop for SensitiveJson {
    fn drop(&mut self) {
        scrub(&mut self.0);
    }
}

fn key_valid(key: &str) -> bool {
    if key.len() > 240 || key.contains("..") {
        return false;
    }
    let mut parts = key.split('/');
    if parts.next() != Some("model") {
        return false;
    }
    for _ in 0..2 {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.is_empty()
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        {
            return false;
        }
    }
    parts.next().is_none()
}

struct RequestWriter(Zeroizing<Vec<u8>>);
impl std::io::Write for RequestWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_REQUEST {
            return Err(std::io::ErrorKind::FileTooLarge.into());
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl HelperClient {
    /// The host resolves the existing explicit-path/adjacent executable policy.
    /// Absolute paths avoid searching PATH or invoking a shell.
    pub fn new(
        executable: &Path,
        data_home: &Path,
        deadline: Duration,
    ) -> Result<Self, CredentialError> {
        if !executable.is_absolute()
            || !data_home.is_absolute()
            || deadline.is_zero()
            || deadline > Duration::from_secs(10)
        {
            return Err(CredentialError::Unavailable);
        }
        Ok(Self {
            executable: executable.to_owned(),
            data_home: data_home.to_owned(),
            deadline,
            permits: Semaphore::new(4),
        })
    }

    pub async fn ping(&self, cancel: &CancellationToken) -> Result<(), CredentialError> {
        let result = self
            .invoke(json!({"version":1,"action":"ping"}), cancel)
            .await?;
        if result.0["status"].as_str().is_none_or(str::is_empty) {
            return Err(CredentialError::ResponseInvalid);
        }
        Ok(())
    }

    pub async fn get(
        &self,
        key: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<Secret>, CredentialError> {
        if !key_valid(key) {
            return Err(CredentialError::InvalidKey);
        }
        let mut result = self
            .invoke(json!({"version":1,"action":"get","key":key}), cancel)
            .await?;
        match result.0.get_mut("secret") {
            Some(Value::Null) => Ok(None),
            Some(value @ Value::String(_)) => {
                let Value::String(secret) = value.take() else {
                    unreachable!("checked string")
                };
                let secret = Secret(Zeroizing::new(secret));
                if secret.expose().is_empty() || secret.expose().len() > MAX_SECRET {
                    return Err(CredentialError::ResponseInvalid);
                }
                Ok(Some(secret))
            }
            _ => Err(CredentialError::ResponseInvalid),
        }
    }

    pub async fn set(
        &self,
        key: &str,
        secret: &str,
        cancel: &CancellationToken,
    ) -> Result<(), CredentialError> {
        if !key_valid(key) {
            return Err(CredentialError::InvalidKey);
        }
        if secret.is_empty() || secret.len() > MAX_SECRET {
            return Err(CredentialError::InvalidSecret);
        }
        #[derive(Serialize)]
        struct SetRequest<'a> {
            version: u8,
            action: &'a str,
            key: &'a str,
            secret: &'a str,
        }
        self.invoke(
            SetRequest {
                version: 1,
                action: "set",
                key,
                secret,
            },
            cancel,
        )
        .await?;
        Ok(())
    }

    pub async fn delete(
        &self,
        key: &str,
        cancel: &CancellationToken,
    ) -> Result<bool, CredentialError> {
        if !key_valid(key) {
            return Err(CredentialError::InvalidKey);
        }
        let result = self
            .invoke(json!({"version":1,"action":"delete","key":key}), cancel)
            .await?;
        result.0["deleted"]
            .as_bool()
            .ok_or(CredentialError::ResponseInvalid)
    }

    async fn invoke(
        &self,
        request: impl Serialize,
        cancel: &CancellationToken,
    ) -> Result<SensitiveJson, CredentialError> {
        let mut writer = RequestWriter(Zeroizing::new(Vec::new()));
        serde_json::to_writer(&mut writer, &request).map_err(|_| CredentialError::InvalidSecret)?;
        self.invoke_bytes(&writer.0, cancel).await
    }

    async fn invoke_bytes(
        &self,
        bytes: &[u8],
        cancel: &CancellationToken,
    ) -> Result<SensitiveJson, CredentialError> {
        if cancel.is_cancelled() {
            return Err(CredentialError::Cancelled);
        }
        if bytes.len() > MAX_REQUEST {
            return Err(CredentialError::InvalidSecret);
        }
        let _permit = self
            .permits
            .try_acquire()
            .map_err(|_| CredentialError::Busy)?;
        let mut child = Command::new(&self.executable)
            .env("PEER_AGENT_HOME", &self.data_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| CredentialError::Unavailable)?;
        let mut stdin = child.stdin.take().ok_or(CredentialError::Unavailable)?;
        let stdout = child.stdout.take().ok_or(CredentialError::Unavailable)?;
        let stderr = child.stderr.take().ok_or(CredentialError::Unavailable)?;
        let exchange = async {
            let write = async {
                stdin
                    .write_all(bytes)
                    .await
                    .map_err(|_| CredentialError::Unavailable)?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| CredentialError::Unavailable)?;
                drop(stdin);
                Ok::<_, CredentialError>(())
            };
            let wait = async { child.wait().await.map_err(|_| CredentialError::Unavailable) };
            let (_, output, _, status) = tokio::try_join!(
                write,
                read_bounded(stdout, MAX_RESPONSE),
                read_bounded(stderr, 64 * 1024),
                wait
            )?;
            Ok((output, status))
        };
        let outcome = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(CredentialError::Cancelled),
            _ = tokio::time::sleep(self.deadline) => Err(CredentialError::Timeout),
            result = exchange => result,
        };
        if outcome.is_err() {
            // kill_on_drop also covers callers dropping/aborting this future.
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let (output, status) = outcome?;
        let decoded = decode_json_bounded(
            &output,
            JsonLimits {
                bytes: MAX_RESPONSE,
                nodes: 1024,
                depth: 16,
                string_bytes: MAX_RESPONSE,
            },
        )
        .map_err(|_| CredentialError::ResponseInvalid)?;
        let mut response = decoded.value;
        if response["version"].as_u64() != Some(1) || !response["ok"].is_boolean() {
            scrub(&mut response);
            return Err(CredentialError::ResponseInvalid);
        }
        if response["ok"] != true {
            // Error bodies and stderr are untrusted; neither is exposed or logged.
            let error = match response["error"]["code"].as_str() {
                Some("secure_storage_unavailable") => CredentialError::SecureStorageUnavailable,
                Some("vault_master_key_missing") => CredentialError::MasterKeyMissing,
                Some("vault_master_key_invalid") => CredentialError::MasterKeyInvalid,
                Some("credential_vault_unavailable") => CredentialError::VaultUnavailable,
                Some("credential_vault_invalid") => CredentialError::VaultInvalid,
                Some("credential_vault_authentication_failed") => {
                    CredentialError::VaultAuthenticationFailed
                }
                _ => CredentialError::HelperRejected,
            };
            scrub(&mut response);
            return Err(error);
        }
        if !status.success() {
            scrub(&mut response);
            return Err(CredentialError::HelperRejected);
        }
        if !response["data"].is_object() {
            scrub(&mut response);
            return Err(CredentialError::ResponseInvalid);
        }
        let data = response["data"].take();
        scrub(&mut response);
        Ok(SensitiveJson(data))
    }
}

fn scrub(value: &mut Value) {
    use zeroize::Zeroize;
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(scrub),
        Value::Object(o) => {
            for (mut key, mut value) in std::mem::take(o) {
                key.zeroize();
                scrub(&mut value);
            }
        }
        _ => {}
    }
}

async fn read_bounded(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, CredentialError> {
    let mut bytes = Zeroizing::new(Vec::new());
    let mut chunk = Zeroizing::new([0u8; 4096]);
    loop {
        let read = reader
            .read(chunk.as_mut_slice())
            .await
            .map_err(|_| CredentialError::Unavailable)?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(read) > limit {
            return Err(CredentialError::ResponseLimit);
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}
