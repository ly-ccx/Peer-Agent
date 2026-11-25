//! Selected identity fence and config ownership for short credential operations.
use super::{CancellationToken, ModelError, read};
use serde_json::Value;
use std::path::{Path, PathBuf};
pub(crate) struct ModelBinding {
    home: PathBuf,
    channel: Value,
    model: Value,
}
impl ModelBinding {
    pub(crate) fn channel_id(&self) -> &str {
        self.channel["id"]
            .as_str()
            .expect("validated channel identity")
    }
    pub(crate) fn new(home: &Path, config: &Value, selected: &Value) -> Result<Self, ModelError> {
        let model = config["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"] == selected["modelProviderId"])
            .ok_or(ModelError::new("model_selection_unavailable"))?
            .clone();
        let channel = config["channels"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"] == model["groupId"])
            .ok_or(ModelError::new("model_selection_unavailable"))?
            .clone();
        Ok(Self {
            home: home.into(),
            channel,
            model,
        })
    }
    pub(crate) fn validate(&self) -> Result<(), ModelError> {
        let config = read(&self.home.join("llm-providers.json"))?;
        self.validate_value(&config)
    }
    pub(crate) async fn transaction(
        &self,
        cancel: &CancellationToken,
    ) -> Result<peer_store::ModelConfigTransaction, ModelError> {
        let guard = super::transaction(&self.home, cancel).await?;
        self.validate_value(&guard.snapshot().value)?;
        Ok(guard)
    }
    fn validate_value(&self, config: &Value) -> Result<(), ModelError> {
        let matches = |field: &str, original: &Value| {
            config[field].as_array().is_some_and(|values| {
                let mut values = values.iter().filter(|v| v["id"] == original["id"]);
                values.next().is_some_and(|current| {
                    peer_protocol::model_config_binding(current)
                        .ok()
                        .zip(peer_protocol::model_config_binding(original).ok())
                        .is_some_and(|(a, b)| a == b)
                }) && values.next().is_none()
            })
        };
        if config["version"] != 2
            || !matches("channels", &self.channel)
            || !matches("models", &self.model)
        {
            return Err(ModelError::new("model_configuration_changed"));
        }
        Ok(())
    }
}
