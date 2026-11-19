//! Read-only original CLI catalog. No Helper, secret unsealing or task admission.
use crate::{model::ModelError, model_config};
use peer_protocol::ModelCatalogEntry;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
pub(crate) mod environment;
mod exec;
mod session;
pub use exec::{
    ExecSelection, ExecSelectionError, ExecSelectionErrorKind, resolve_catalog,
    resolve_exact_session_model, resolve_exec,
};
pub use session::{
    ContextOption, ContextOptions, ContextSelection, SessionModelMetadata, session_models,
};
pub(crate) fn trim(s: &str) -> &str {
    // ECMAScript String.trim, including BOM and excluding NEL.
    s.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().map(trim).filter(|s| !s.is_empty())
}
fn group(v: &Value) -> Option<&str> {
    text(v, "groupId").or_else(|| text(v, "id"))
}
pub fn load(home: Option<&Path>) -> Result<Vec<ModelCatalogEntry>, ModelError> {
    if let Some(env) = environment::Environment::read()? {
        return Ok(vec![env.entry()]);
    }
    let Some(home) = home else { return Ok(vec![]) };
    let file = home.join("llm-providers.json");
    if !file
        .try_exists()
        .map_err(|_| ModelError::new("model_config_unavailable"))?
    {
        return Ok(vec![]);
    }
    project(&model_config::read(&file)?)
}
fn rows(value: &Value) -> Result<Vec<Value>, ModelError> {
    if value.is_object() && value.get("version").is_some_and(|v| v != 2) {
        return Err(ModelError::new("model_config_version_unsupported"));
    }
    if let Some(rows) = value.as_array().or_else(|| value["providers"].as_array()) {
        return Ok(rows.clone());
    }
    let mut channels = BTreeMap::new();
    for channel in value["channels"]
        .as_array()
        .ok_or(ModelError::new("model_config_invalid"))?
    {
        if let Some(id) = group(channel) {
            let mut c = channel.clone();
            c["id"] = json!(id);
            c["groupId"] = json!(id);
            channels.insert(id.to_owned(), c);
        }
    }
    let mut rows = vec![];
    for model in value["models"]
        .as_array()
        .ok_or(ModelError::new("model_config_invalid"))?
    {
        if let Some(id) = group(model)
            && let Some(channel) = channels.get(id)
        {
            let mut row = channel.clone();
            row.as_object_mut()
                .ok_or(ModelError::new("model_config_invalid"))?
                .extend(
                    model
                        .as_object()
                        .ok_or(ModelError::new("model_config_invalid"))?
                        .clone(),
                );
            if row["id"].is_null() {
                row["id"] = json!(id);
            }
            row["groupId"] = json!(id);
            rows.push(row);
        }
    }
    Ok(rows)
}
pub(crate) fn project(value: &Value) -> Result<Vec<ModelCatalogEntry>, ModelError> {
    let mut out = vec![];
    for row in rows(value)? {
        if !row.is_object() {
            return Err(ModelError::new("model_config_invalid"));
        }
        let Some(model) = text(&row, "model") else {
            continue;
        };
        let Some(id) = group(&row) else { continue };
        let ready = match text(&row, "authMethod").unwrap_or("api_key") {
            "qoder_local_auth" => true,
            "oauth_chatgpt" | "oauth_google" | "oauth_grok" => row["oauthConfigured"] == true,
            _ => row["apiKeyConfigured"] == true,
        };
        if row["enabled"] == false || !ready {
            continue;
        }
        let all = ["off", "low", "medium", "default", "high", "xhigh", "max"];
        let mut levels: Vec<String> = all
            .into_iter()
            .filter(|s| {
                row["reasoningEffortLevels"]
                    .as_array()
                    .is_some_and(|v| v.iter().any(|v| v == s))
            })
            .map(str::to_owned)
            .collect();
        if levels.is_empty() {
            levels = ["off", "low", "default", "high"].map(str::to_owned).into();
        }
        let preferred =
            text(&row, "reasoningDefaultEffort").filter(|s| levels.iter().any(|v| v == s));
        let effort = preferred
            .or_else(|| {
                ["high", "default", "medium", "low"]
                    .into_iter()
                    .find(|s| levels.iter().any(|v| v == s))
            })
            .unwrap_or(&levels[0])
            .to_owned();
        out.push(ModelCatalogEntry {
            provider_id: id.into(),
            model_id: model.into(),
            entry_id: text(&row, "id").map(str::to_owned),
            display_name: format!(
                "{} · {}",
                text(&row, "modelLabel").unwrap_or(model),
                text(&row, "name").unwrap_or(model)
            ),
            context_window: row["contextWindow"]
                .as_f64()
                .filter(|n| n.is_finite() && *n > 0. && *n <= 9_007_199_254_740_991.)
                .map(|n| n.floor() as u64),
            supports_tools: true,
            supported_reasoning_efforts: levels,
            default_reasoning_effort: effort,
            available: true,
        });
    }
    Ok(out)
}

pub fn supports_fast_mode(home: &Path, provider_id: &str, model_id: &str) -> bool {
    let file = home.join("llm-providers.json");
    let Ok(true) = file.try_exists() else {
        return false;
    };
    let Ok(doc) = model_config::read(&file) else {
        return false;
    };
    let Ok(flat) = rows(&doc) else {
        return false;
    };
    flat.iter().any(|row| {
        let row_group = group(row);
        let row_id = text(row, "id");
        let row_model = text(row, "model");
        (row_group == Some(provider_id) || row_id == Some(provider_id))
            && row_model == Some(model_id)
            && matches!(
                text(row, "authMethod"),
                Some("oauth_chatgpt" | "oauth_grok")
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_matches_the_actual_original_ts_entry_and_environment_catalog() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-catalog.json"
        ))
        .unwrap();
        for case in data["cases"].as_array().unwrap() {
            let env = environment::Environment::from_lookup(|key| {
                case["env"][key].as_str().map(str::to_owned)
            })
            .unwrap();
            let actual = if let Some(env) = env {
                vec![env.entry()]
            } else if let Some(doc) = case.get("document") {
                project(doc).unwrap()
            } else {
                vec![]
            };
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                case["expected"]["catalog"],
                "{}",
                case["name"]
            );
        }
    }
}
