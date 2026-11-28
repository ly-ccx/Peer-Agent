//! Existing file-read scope facts. Deserializing these facts cannot grant I/O.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocalReadScopeKind {
    #[serde(rename = "file-read")]
    FileRead,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalReadPermissionScope {
    pub kind: LocalReadScopeKind,
    pub capability_id: String,
    pub path: String,
    pub workspace_path: Option<String>,
}
