use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;
const MAX_KEY_LEN: usize = 240;
const MAX_SECRET_LEN: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
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
}

impl Request {
    pub fn version(&self) -> u8 {
        match self {
            Self::Ping { version }
            | Self::Get { version, .. }
            | Self::Set { version, .. }
            | Self::Delete { version, .. } => *version,
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
        }
    }
}

fn validate_key(key: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err("credential_key_invalid");
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
}
