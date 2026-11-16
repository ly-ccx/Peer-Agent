//! Local catalog decoding is read-only and bound to the prepared account.
use super::{
    CACHE_LIMIT,
    account_files::{self, Observation},
    sensitive_json::SensitiveJson,
};
use crate::{CancellationToken, model::ModelError};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
fn invalid() -> ModelError {
    ModelError::new("qoder_catalog_invalid")
}
#[derive(Default)]
pub(super) struct Catalog {
    models: Vec<Value>,
    files: Vec<Observation>,
    absent: Vec<PathBuf>,
}
impl Catalog {
    fn read(
        &mut self,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, ModelError> {
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.absent.push(path.into());
                Ok(None)
            }
            Err(_) => Err(ModelError::new("qoder_catalog_unavailable")),
            Ok(_) => {
                let (bytes, observation) = account_files::read(path, CACHE_LIMIT, cancel)?;
                self.files.push(observation);
                Ok(Some(bytes))
            }
        }
    }
    pub fn load(root: &Path, uid: &str, cancel: &CancellationToken) -> Result<Self, ModelError> {
        let mut result = Self::default();
        if let Some(bytes) = result.read(&root.join(".models/default"), cancel)? {
            let info = SensitiveJson::parse(&bytes, CACHE_LIMIT)?;
            let indexed = info.0["uid"]
                .as_str()
                .map(str::trim)
                .filter(|s| {
                    !s.is_empty() && *s != "." && *s != ".." && !s.contains(['/', '\\', '\0'])
                })
                .ok_or_else(invalid)?;
            if indexed != uid {
                return Err(ModelError::new("qoder_catalog_account_changed"));
            }
            for name in ["catalog-v5", "catalog-v4", "catalog-v2", "catalog"] {
                let path = root.join(".models").join(indexed).join(name);
                if let Some(bytes) = result.read(&path, cancel)? {
                    let encoded = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
                    let decoded =
                        super::decrypt_cache(encoded, indexed.as_bytes()).map_err(|_| invalid())?;
                    result.models = parse(decoded.text.expose().as_bytes())?;
                    break;
                }
            }
        }
        let legacy = if let Some(bytes) = result.read(&root.join(".auth/models"), cancel)? {
            parse(&bytes)?
        } else {
            Vec::new()
        };
        if result.models.is_empty() {
            result.models = legacy;
        } else {
            for model in &mut result.models {
                if model["maxOutputTokens"].is_null()
                    && let Some(other) = legacy.iter().find(|v| {
                        v["id"]
                            .as_str()
                            .zip(model["id"].as_str())
                            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
                    })
                    && let Some(limit) = other.get("maxOutputTokens")
                {
                    model["maxOutputTokens"] = limit.clone();
                }
            }
        }
        if result.models.is_empty() {
            result.models.push(json!({"id":"auto","label":"Auto","contextWindow":180000,"maxOutputTokens":32768,"supportsVision":true,"supportsReasoning":false}));
        }
        Ok(result)
    }
    pub fn validate(&self) -> Result<(), ModelError> {
        for file in &self.files {
            file.validate()?;
        }
        for path in &self.absent {
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(ModelError::new("qoder_auth_changed")),
            }
        }
        Ok(())
    }
    pub fn metadata(&self, model: &str, options: Option<&Value>) -> Result<Value, ModelError> {
        let mut metadata = match self.models.iter().find(|v| {
            v["id"]
                .as_str()
                .is_some_and(|id| id.eq_ignore_ascii_case(model.trim()))
        }) {
            Some(value) => value.clone(),
            None if options
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty()) =>
            {
                json!({"id":model.trim(),"label":model,"source":"system","format":"openai","supportsVision":true,"supportsReasoning":false})
            }
            None => return Err(ModelError::new("native_qoder_legacy_wire_unsupported")),
        };
        if let Some(options) = options {
            if !options.is_array() {
                return Err(invalid());
            }
            metadata["modelOptions"] = options.clone();
        }
        Ok(metadata)
    }
}
fn number(n: f64) -> Value {
    if (0.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0 {
        json!(n as u64)
    } else {
        json!(n)
    }
}
fn positive(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.0)
}
fn parse(bytes: &[u8]) -> Result<Vec<Value>, ModelError> {
    let value = SensitiveJson::parse(bytes, CACHE_LIMIT)?;
    if !value.0.is_object() {
        return Err(invalid());
    }
    let raw = ["chat", "assistant"]
        .iter()
        .find_map(|key| value.0[*key].as_array().filter(|a| !a.is_empty()));
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for raw in raw.into_iter().flatten().filter(|v| v.is_object()) {
        let Some(id) = ["key", "id", "model"]
            .iter()
            .find_map(|key| raw[*key].as_str().filter(|s| !s.is_empty()))
            .map(str::trim)
        else {
            continue;
        };
        if id.is_empty() || !seen.insert(id.to_owned()) {
            continue;
        }
        let label = ["display_name", "displayName", "label"]
            .iter()
            .find_map(|key| raw[*key].as_str().filter(|s| !s.is_empty()))
            .unwrap_or(id);
        let mut model = json!({
            "id": id, "label": label,
            "source": raw["source"].as_str().filter(|s| !s.is_empty()).unwrap_or("system"),
            "format": raw["format"].as_str().filter(|s| !s.is_empty()).unwrap_or("openai")
        });
        for (wire, key) in [
            ("is_vl", "supportsVision"),
            ("is_reasoning", "supportsReasoning"),
        ] {
            if let Some(value) = raw[wire].as_bool() {
                model[key] = json!(value);
            }
        }
        if positive(&raw["max_input_tokens"]).is_some() {
            model["contextWindow"] = raw["max_input_tokens"].clone();
        }
        if raw["max_output_tokens"].as_f64().is_some() {
            model["maxOutputTokens"] = raw["max_output_tokens"].clone();
        }
        if let Some(option) = context_option(raw) {
            model["modelOptions"] = json!([option]);
        }
        thinking(raw, &mut model);
        models.push(model);
    }
    Ok(models)
}
fn context_option(raw: &Value) -> Option<Value> {
    let entries: Vec<_> = raw["context_config"]
        .as_object()?
        .iter()
        .filter(|(name, v)| !name.trim().is_empty() && positive(&v["token_count"]).is_some())
        .collect();
    let (default_name, default) = entries
        .iter()
        .find(|(_, v)| v["is_default"] == true)
        .unwrap_or(entries.first()?);
    let input = positive(&raw["max_input_tokens"]).unwrap_or(positive(&default["token_count"])?);
    let mut windows = entries
        .iter()
        .filter_map(|(_, v)| positive(&v["token_count"]))
        .collect::<Vec<_>>();
    windows.sort_by(f64::total_cmp);
    let anchor = windows
        .iter()
        .find(|n| **n >= input)
        .or_else(|| windows.last())?;
    let reserved = (anchor - input).max(0.0);
    Some(
        json!({"id":"contextTier","label":"上下文档位","kind":"select","description":"总上下文窗口；最大输入会为模型输出和运行时内容预留空间。","defaultValue":default_name,"choices":entries.iter().map(|(name,v)|json!({"value":name,"label":name,"requestValue":name,"contextWindow":v["token_count"],"inputTokenLimit":positive(&v["token_count"]).map(|n|number((n-reserved).max(1.0)))})).collect::<Vec<_>>()}),
    )
}
fn thinking(raw: &Value, model: &mut Value) {
    let Some(config) = raw
        .get("thinking_config")
        .filter(|v| v.is_object())
        .or_else(|| {
            raw["serverModel"]
                .get("thinking_config")
                .filter(|v| v.is_object())
        })
    else {
        return;
    };
    let disabled = config["disabled"].is_object();
    let enabled = config["enabled"].as_object();
    if !disabled && enabled.is_none() {
        return;
    }
    let efforts = config["enabled"]["efforts"].as_object();
    let keys: Vec<_> = efforts
        .into_iter()
        .flatten()
        .map(|(key, _)| key.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let mut levels: Vec<String> = if disabled {
        vec!["off".into()]
    } else {
        Vec::new()
    };
    for key in ["low", "medium", "high", "xhigh", "max"] {
        if keys.iter().any(|k| k == key) {
            levels.push(key.into());
        }
    }
    for key in &keys {
        if key != "default" && !levels.contains(key) {
            levels.push(key.clone());
        }
    }
    if levels.is_empty() {
        return;
    }
    let first = levels
        .iter()
        .find(|v| v.as_str() != "off")
        .unwrap_or(&levels[0]);
    let explicit = efforts
        .into_iter()
        .flatten()
        .find(|(_, v)| v["is_default"] == true)
        .map(|(k, _)| k.trim().to_lowercase());
    let mut default = explicit.unwrap_or_else(|| {
        if config["enabled"]["is_default"] == true {
            first.clone()
        } else if disabled && config["disabled"]["is_default"] == true {
            "off".into()
        } else {
            first.clone()
        }
    });
    if !levels.contains(&default) {
        default = first.clone();
    }
    model["supportsReasoning"] = json!(true);
    model["reasoningEffortLevels"] = json!(levels);
    model["reasoningDefaultEffort"] = json!(default);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_catalog_context_and_thinking_match_actual_ts() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/qoder-requests.json"
        ))
        .unwrap();
        for case in data["catalogs"].as_array().unwrap() {
            assert_eq!(
                parse(&serde_json::to_vec(&case["input"]).unwrap()).unwrap(),
                case["expected"].as_array().unwrap().clone()
            );
        }
    }
}
