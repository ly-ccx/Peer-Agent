//! Existing PEER_MODEL_* source. The owned secret never enters catalog DTOs,
//! configuration files, Context or Tool/Evidence facts.
use super::{ModelCatalogEntry, ModelError, trim};
use crate::{
    credentials::Secret,
    model::{
        ModelConfig, NativeModel,
        wire::{ChatDialect, GenerationOptions, Wire},
    },
};
use serde_json::Value;
use std::time::Duration;
pub(crate) const ID: &str = "openai-compatible";
pub(crate) struct Environment {
    key: Secret,
    model: String,
    base: String,
}
impl Environment {
    pub(crate) fn read() -> Result<Option<Self>, ModelError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }
    pub(crate) fn from_lookup(
        get: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, ModelError> {
        let Some(key) = get("PEER_MODEL_API_KEY").map(zeroize::Zeroizing::new) else {
            return Ok(None);
        };
        let key = trim(&key);
        if key.is_empty() {
            return Ok(None);
        }
        let key = Secret::from_string(key.to_owned())
            .map_err(|_| ModelError::new("model_environment_key_invalid"))?;
        let value = |key: &str, fallback: &str| {
            get(key)
                .as_deref()
                .map(trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_owned()
        };
        Ok(Some(Self {
            key,
            model: value("PEER_MODEL_ID", "gpt-4o-mini"),
            base: value("PEER_MODEL_BASE_URL", "https://api.openai.com/v1"),
        }))
    }
    pub(crate) fn entry(&self) -> ModelCatalogEntry {
        ModelCatalogEntry {
            provider_id: ID.into(),
            model_id: self.model.clone(),
            entry_id: None,
            display_name: self.model.clone(),
            context_window: None,
            supports_tools: true,
            supported_reasoning_efforts: ["off", "low", "default", "high"]
                .map(str::to_owned)
                .into(),
            default_reasoning_effort: "default".into(),
            available: true,
        }
    }
    fn into_model(self, selection: &Value) -> Result<NativeModel, ModelError> {
        if selection["modelId"] != self.model {
            return Err(ModelError::new("model_selection_unavailable"));
        }
        let effort = selection["reasoningEffort"].as_str().unwrap_or("default");
        if !["off", "low", "default", "high"].contains(&effort) {
            return Err(ModelError::new("model_selection_invalid"));
        }
        if reqwest::header::HeaderValue::from_str(&format!("Bearer {}", self.key.expose())).is_err()
        {
            return Err(ModelError::new("model_environment_key_invalid"));
        }
        NativeModel::new(
            ModelConfig {
                endpoint: format!("{}/chat/completions", self.base.trim_end_matches('/')),
                model: self.model,
                provider: ID.into(),
                wire: Wire::Chat,
                generation: GenerationOptions {
                    effort: effort.into(),
                    chat_dialect: ChatDialect::Environment,
                    ..Default::default()
                },
            },
            Some(self.key),
            Duration::from_secs(120),
        )
    }
}
pub(crate) fn selected(selection: &Value) -> Result<Option<NativeModel>, ModelError> {
    if selection["providerId"] != ID
        || ["modelProviderId", "family"]
            .iter()
            .any(|key| selection.get(*key).is_some_and(|v| !v.is_null() && v != ID))
    {
        return Ok(None);
    }
    Environment::read()?
        .ok_or(ModelError::new("model_environment_unconfigured"))?
        .into_model(selection)
        .map(Some)
}
