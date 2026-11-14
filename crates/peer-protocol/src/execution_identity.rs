use serde::Serialize;
use serde_json::Value;

/// Shape only. The host must compare this with the current canonical plan,
/// coordination binding, lease and resource ledger before dispatch or commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExecutionIdentity {
    pub plan_id: String,
    pub session_id: String,
    pub execution_epoch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
}

pub fn normalize_session_execution_identity(raw: &Value) -> Option<SessionExecutionIdentity> {
    let value = raw.as_object()?;
    if value.keys().any(|key| {
        !matches!(
            key.as_str(),
            "planId" | "sessionId" | "executionEpoch" | "goalRevision" | "generation"
        )
    }) {
        return None;
    }
    fn token(value: &Value) -> Option<String> {
        let text = value.as_str()?;
        if text.is_empty()
            || text.len() > 256
            || !text.as_bytes()[0].is_ascii_alphanumeric()
            || text.contains("..")
            || !text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
        {
            return None;
        }
        Some(text.to_owned())
    }
    let execution_epoch = value.get("executionEpoch")?.as_str()?;
    if execution_epoch.is_empty()
        || execution_epoch.encode_utf16().count() > 512
        || execution_epoch.chars().any(|c| (c as u32) < 32)
    {
        return None;
    }
    let goal_revision = match value.get("goalRevision") {
        None => None,
        Some(number) => {
            let number = number.as_f64()?;
            if number.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&number) {
                return None;
            }
            Some(number as u64)
        }
    };
    let generation = match value.get("generation") {
        None => None,
        Some(raw) => Some(token(raw)?),
    };
    Some(SessionExecutionIdentity {
        plan_id: token(value.get("planId")?)?,
        session_id: token(value.get("sessionId")?)?,
        execution_epoch: execution_epoch.to_owned(),
        goal_revision,
        generation,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionResourceScope {
    Directory { path: String },
    File { path: String },
    GitRef { r#ref: String },
    RemoteObject { r#ref: String },
}

pub fn normalize_execution_resource_scope(raw: &Value) -> Option<ExecutionResourceScope> {
    let value = raw.as_object()?;
    if value.len() != 2 {
        return None;
    }
    match value.get("kind")?.as_str()? {
        kind @ ("directory" | "file") => {
            let path = value.get("path")?.as_str()?;
            if path.is_empty()
                || path.encode_utf16().count() > 2048
                || path.chars().any(|c| (c as u32) < 32)
            {
                return None;
            }
            Some(if kind == "directory" {
                ExecutionResourceScope::Directory {
                    path: path.to_owned(),
                }
            } else {
                ExecutionResourceScope::File {
                    path: path.to_owned(),
                }
            })
        }
        kind @ ("git_ref" | "remote_object") => {
            let reference = value.get("ref")?.as_str()?;
            if reference.is_empty()
                || reference.len() > 512
                || !reference.as_bytes()[0].is_ascii_alphanumeric()
                || reference.contains("..")
                || !reference.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'-')
                })
            {
                return None;
            }
            Some(if kind == "git_ref" {
                ExecutionResourceScope::GitRef {
                    r#ref: reference.to_owned(),
                }
            } else {
                ExecutionResourceScope::RemoteObject {
                    r#ref: reference.to_owned(),
                }
            })
        }
        _ => None,
    }
}
