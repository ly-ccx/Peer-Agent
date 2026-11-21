use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostSurface {
    Desktop,
    Tui,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLeaseRecord {
    pub host_id: String,
    pub surface: HostSurface,
    pub pid: u32,
    #[serde(default)]
    pub app_version: String,
    pub acquired_at: String,
    pub heartbeat_at: String,
}
