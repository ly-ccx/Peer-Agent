//! Session controls use canonical catalog identities and provider declarations.
use super::*;
use std::collections::HashSet;

#[derive(Clone)]
pub struct SessionModelMetadata {
    pub provider_id: String,
    pub model_id: String,
    pub group_label: String,
    pub model_label: String,
    pub reasoning: bool,
    pub context: Option<ContextOptions>,
}

#[derive(Clone)]
pub struct ContextOption {
    pub value: Value,
    /// The exact option token exposed to the protocol client.
    pub wire_value: String,
    pub label: String,
    pub window: Option<u64>,
}

#[derive(Clone)]
pub struct ContextSelection {
    pub option_id: String,
    pub value: Value,
}

#[derive(Clone)]
pub struct ContextOptions {
    pub id: String,
    pub choices: Vec<ContextOption>,
    pub default: Option<Value>,
}
impl ContextOptions {
    pub(crate) fn from_declaration(row: &Value) -> Option<Self> {
        let definition = row["modelOptions"].as_array()?.iter().find(|option| {
            option["choices"].as_array().is_some_and(|choices| {
                choices
                    .iter()
                    .any(|choice| window(&choice["contextWindow"]).is_some())
            })
        })?;
        let id = text(definition, "id")?.to_owned();
        let mut choices = Vec::new();
        let mut seen = HashSet::new();
        for choice in definition["choices"].as_array()? {
            let value = choice["value"].clone();
            if !(value.is_string() || value.is_boolean() || value.is_number()) {
                continue;
            }
            let Some(label) = text(choice, "label") else {
                continue;
            };
            let wire_value = peer_protocol::javascript_json_string(&value).ok()?;
            if !seen.insert(wire_value.clone()) {
                return None;
            }
            choices.push(ContextOption {
                value,
                wire_value,
                label: label.to_owned(),
                window: window(&choice["contextWindow"]),
            });
        }
        if !choices.iter().any(|choice| choice.window.is_some()) {
            return None;
        }
        let candidate = row["modelOptionValues"]
            .get(&id)
            .filter(|value| !value.is_null())
            .unwrap_or(&definition["defaultValue"]);
        let mut options = Self {
            id,
            choices,
            default: None,
        };
        options.default = [candidate, &definition["defaultValue"]]
            .into_iter()
            .find_map(|value| options.choice(value).map(|choice| choice.value.clone()));
        Some(options)
    }
    pub fn choice(&self, value: &Value) -> Option<&ContextOption> {
        let wire_value = peer_protocol::javascript_json_string(value).ok()?;
        self.choices
            .iter()
            .find(|choice| choice.wire_value == wire_value)
    }
}
fn window(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 1. && *n <= 9_007_199_254_740_991.)
        .map(|n| n.floor() as u64)
}

pub fn session_models(home: &Path) -> Result<Vec<SessionModelMetadata>, ModelError> {
    if let Some(environment) = environment::Environment::read()? {
        let entry = environment.entry();
        return Ok(vec![SessionModelMetadata {
            group_label: "Peer".into(),
            model_label: entry.model_id.clone(),
            provider_id: entry.provider_id,
            model_id: entry.model_id,
            reasoning: false,
            context: None,
        }]);
    }
    let document = model_config::read(&home.join("llm-providers.json"))?;
    let flat = rows(&document)?;
    let projected = project(&document)?;
    let mut entries = Vec::new();
    for entry in projected.into_iter().filter(|entry| entry.available) {
        let Some(row) = flat
            .iter()
            .find(|row| row["id"].as_str() == entry.entry_id.as_deref())
        else {
            continue;
        };
        entries.push(SessionModelMetadata {
            group_label: text(row, "name").unwrap_or("Peer").to_owned(),
            model_label: text(row, "modelLabel")
                .unwrap_or(&entry.model_id)
                .to_owned(),
            reasoning: row["supportsReasoning"] == true
                && entry.supported_reasoning_efforts.len() > 1,
            context: ContextOptions::from_declaration(row),
            provider_id: entry.provider_id,
            model_id: entry.model_id,
        });
    }
    Ok(entries)
}
