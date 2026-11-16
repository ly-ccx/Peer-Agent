use serde::Serialize;
/// Presentation/model selection facts, never a capability or permission grant.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogEntry {
    pub provider_id: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    pub supports_tools: bool,
    pub supported_reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
    pub available: bool,
}
