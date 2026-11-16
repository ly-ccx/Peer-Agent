use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
const MAX_KEY_LEN: usize = 240;
const MAX_SECRET_LEN: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    Ping {
        version: u8,
    },
    Get {
        version: u8,
        key: String,
    },
    Set {
        version: u8,
        key: String,
        secret: String,
    },
    Delete {
        version: u8,
        key: String,
    },
    GetSnapshot {
        version: u8,
        key: String,
    },
    CompareSet {
        version: u8,
        key: String,
        #[serde(
            rename = "expectedRevision",
            deserialize_with = "required_nullable_string"
        )]
        expected_revision: Option<String>,
        #[serde(deserialize_with = "required_nullable_string")]
        secret: Option<String>,
    },
}
fn required_nullable_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

impl Request {
    pub fn version(&self) -> u8 {
        match self {
            Self::Ping { version }
            | Self::Get { version, .. }
            | Self::Set { version, .. }
            | Self::Delete { version, .. }
            | Self::GetSnapshot { version, .. }
            | Self::CompareSet { version, .. } => *version,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version() != PROTOCOL_VERSION {
            return Err("protocol_version_unsupported");
        }
        match self {
            Self::Ping { .. } => Ok(()),
            Self::Get { key, .. } | Self::Delete { key, .. } => validate_key(key),
            Self::Set { key, secret, .. } => {
                validate_key(key)?;
                if secret.is_empty() || secret.len() > MAX_SECRET_LEN {
                    return Err("credential_secret_invalid");
                }
                Ok(())
            }
            Self::GetSnapshot { key, .. } => validate_oauth_key(key),
            Self::CompareSet {
                key,
                expected_revision,
                secret,
                ..
            } => {
                validate_oauth_key(key)?;
                if let Some(revision) = expected_revision {
                    validate_revision(revision)?;
                }
                if secret
                    .as_ref()
                    .is_some_and(|s| s.is_empty() || s.len() > MAX_SECRET_LEN)
                {
                    return Err("credential_secret_invalid");
                }
                Ok(())
            }
        }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        match self {
            Self::Set { secret, .. } => secret.zeroize(),
            Self::CompareSet {
                secret: Some(secret),
                ..
            } => secret.zeroize(),
            _ => {}
        }
    }
}
fn validate_oauth_key(key: &str) -> Result<(), &'static str> {
    validate_key(key)?;
    let parts: Vec<_> = key.split('/').collect();
    if parts.len() != 3 || parts[0] != "model" || parts[1].is_empty() || parts[2] != "oauth-tokens"
    {
        return Err("credential_key_namespace_denied");
    }
    Ok(())
}
fn validate_revision(revision: &str) -> Result<(), &'static str> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    if revision.len() != 16 || !STANDARD.decode(revision).is_ok_and(|v| v.len() == 12) {
        return Err("credential_revision_invalid");
    }
    Ok(())
}
impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialHelperRequest")
            .field("version", &self.version())
            .finish_non_exhaustive()
    }
}

fn validate_key(key: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err("credential_key_invalid");
    }
    if key.starts_with("mcp/") {
        let parts: Vec<_> = key.split('/').collect();
        return if parts.len() == 3
            && parts[1].len() == 64
            && parts[1]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && parts[2].len() == 36
            && parts[2].bytes().enumerate().all(|(i, b)| match i {
                8 | 13 | 18 | 23 => b == b'-',
                14 => b == b'4',
                19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
                _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
            }) {
            Ok(())
        } else {
            Err("credential_key_invalid")
        };
    }
    if !key.starts_with("model/") {
        return Err("credential_key_namespace_denied");
    }
    if !key.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b':')
    }) {
        return Err("credential_key_invalid");
    }
    if key.contains("..") || key.ends_with('/') {
        return Err("credential_key_invalid");
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub version: u8,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl Response {
    pub fn ok(data: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: false,
            data: None,
            error: Some(ErrorBody {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_scoped_model_keys() {
        let request = Request::Get {
            version: 1,
            key: "model/openai/api-key".into(),
        };
        assert!(request.validate().is_ok());
    }
    #[test]
    fn conditional_requests_require_explicit_nullable_preconditions_and_secret() {
        let key = "model/channel/oauth-tokens";
        for value in [
            serde_json::json!({"version":1,"action":"compare-set","key":key,"secret":"next"}),
            serde_json::json!({"version":1,"action":"compare-set","key":key,"expectedRevision":null}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }

    #[test]
    fn rejects_paths_and_other_namespaces() {
        for key in [
            "other/token",
            "model/../token",
            "model/token/",
            "model/key space",
        ] {
            let request = Request::Get {
                version: 1,
                key: key.into(),
            };
            assert!(request.validate().is_err(), "{key}");
        }
    }

    #[test]
    fn rejects_empty_secrets_and_unknown_versions() {
        let empty = Request::Set {
            version: 1,
            key: "model/openai/api-key".into(),
            secret: String::new(),
        };
        assert_eq!(empty.validate(), Err("credential_secret_invalid"));

        let future = Request::Ping { version: 2 };
        assert_eq!(future.validate(), Err("protocol_version_unsupported"));
    }

    #[test]
    fn mcp_slots_have_an_exact_hash_and_rfc4122_v4_generation() {
        let key = format!(
            "mcp/{}/12345678-1234-4123-8123-123456789abc",
            "a".repeat(64)
        );
        assert!(validate_key(&key).is_ok());
        for invalid in [
            key.replace("4123", "5123"),
            key.replace("8123", "c123"),
            format!("{key}/extra"),
            key.to_uppercase(),
            "mcp/arbitrary/token".into(),
        ] {
            assert!(validate_key(&invalid).is_err(), "{invalid}");
        }
    }
}
