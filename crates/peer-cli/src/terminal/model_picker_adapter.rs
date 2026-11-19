//! Adapter bridging `peer_runtime::model_catalog` into pure `peer_tui::ModelPickerGroup`s.
//!
//! Read-only projection: never reads credentials, never invokes providers, never merges
//! same-name models across distinct record IDs (model-picker.md).

use peer_protocol::ModelCatalogEntry;
use peer_tui::{ModelPickerGroup, ModelPickerOption};
use std::{collections::HashMap, path::Path};

/// Split `"model · provider"` (matching OpenTUI's `splitModelDisplayName`) into
/// `(provider_name, model_name)`.
pub(crate) fn split_model_display_name(
    display_name: &str,
    fallback_model_id: &str,
) -> (String, String) {
    let trimmed = display_name.trim();
    if let Some((left, right)) = trimmed.rsplit_once(" · ") {
        let model_part = left.trim();
        let provider_part = right.trim();
        if !model_part.is_empty() {
            let provider_name = if provider_part.is_empty() {
                "Models"
            } else {
                provider_part
            };
            return (provider_name.to_owned(), model_part.to_owned());
        }
    }
    let model_name = if trimmed.is_empty() {
        fallback_model_id
    } else {
        trimmed
    };
    ("Models".to_owned(), model_name.to_owned())
}

fn group_entries(entries: Vec<ModelCatalogEntry>) -> Vec<ModelPickerGroup> {
    let mut groups: Vec<ModelPickerGroup> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    for (idx, entry) in entries.into_iter().enumerate() {
        let record_id = entry
            .entry_id
            .clone()
            .unwrap_or_else(|| format!("{}::{}::{}", entry.provider_id, entry.model_id, idx));
        let (provider_name, model_name) =
            split_model_display_name(&entry.display_name, &entry.model_id);
        let mut badges = Vec::new();
        if entry.supports_tools {
            badges.push("tools".to_owned());
        }
        if let Some(ctx) = entry.context_window {
            let k = ctx / 1000;
            if k > 0 {
                badges.push(format!("{k}K"));
            }
        }
        let supports_reasoning = !entry.supported_reasoning_efforts.is_empty();
        let opt = ModelPickerOption {
            record_id,
            provider_id: entry.provider_id.clone(),
            model_id: entry.model_id,
            display_name: model_name,
            available: entry.available,
            supports_reasoning,
            efforts: entry.supported_reasoning_efforts,
            badges,
        };
        if let Some(&pos) = group_index.get(&entry.provider_id) {
            groups[pos].models.push(opt);
        } else {
            let pos = groups.len();
            group_index.insert(entry.provider_id.clone(), pos);
            groups.push(ModelPickerGroup {
                group_id: entry.provider_id,
                label: provider_name,
                models: vec![opt],
            });
        }
    }
    groups
}

pub(super) fn load_picker_groups(home: &Path) -> Result<Vec<ModelPickerGroup>, &'static str> {
    let entries = peer_runtime::model_catalog::load(Some(home)).map_err(|e| e.code)?;
    Ok(group_entries(entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(provider_id: &str, model_id: &str, display_name: &str) -> ModelCatalogEntry {
        ModelCatalogEntry {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            entry_id: Some(format!("{provider_id}:{model_id}")),
            display_name: display_name.into(),
            context_window: Some(128_000),
            supports_tools: true,
            supported_reasoning_efforts: vec!["off".into(), "default".into()],
            default_reasoning_effort: "default".into(),
            available: true,
        }
    }

    #[test]
    fn split_model_display_name_matches_opentui_rules() {
        assert_eq!(
            split_model_display_name("GPT-6.1 Sol · ChatGPT 订阅", "gpt-6.1-sol"),
            ("ChatGPT 订阅".to_owned(), "GPT-6.1 Sol".to_owned())
        );
        assert_eq!(
            split_model_display_name("Alpha · Beta · Custom Provider", "alpha"),
            ("Custom Provider".to_owned(), "Alpha · Beta".to_owned())
        );
        assert_eq!(
            split_model_display_name("solo-model", "solo-model"),
            ("Models".to_owned(), "solo-model".to_owned())
        );
        assert_eq!(
            split_model_display_name(" · ProviderOnly", "fallback-id"),
            ("Models".to_owned(), "· ProviderOnly".to_owned())
        );
        assert_eq!(
            split_model_display_name("", "fallback-id"),
            ("Models".to_owned(), "fallback-id".to_owned())
        );
    }

    #[test]
    fn group_entries_preserves_order_and_uses_human_readable_labels() {
        let groups = group_entries(vec![
            sample_entry(
                "76625b56-2556-480a-addc-9bc98a9a94eb",
                "gpt-6.1-sol",
                "GPT-6.1 Sol · ChatGPT 订阅",
            ),
            sample_entry(
                "36ad8967-1f3b-401d-b158-6ca8b696d96c",
                "glm-5.3-flash",
                "glm-5.3-flash · OpenCode Go",
            ),
            sample_entry(
                "76625b56-2556-480a-addc-9bc98a9a94eb",
                "gpt-6-astra",
                "GPT-6 Astra · ChatGPT 订阅",
            ),
            sample_entry(
                "99999999-1111-2222-3333-444444444444",
                "other-gpt",
                "Other GPT · ChatGPT 订阅",
            ),
        ]);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].label, "ChatGPT 订阅");
        assert_eq!(groups[0].group_id, "76625b56-2556-480a-addc-9bc98a9a94eb");
        assert_eq!(groups[0].models.len(), 2);
        assert_eq!(groups[0].models[0].display_name, "GPT-6.1 Sol");
        assert_eq!(groups[0].models[1].display_name, "GPT-6 Astra");
        assert_eq!(groups[1].label, "OpenCode Go");
        assert_eq!(groups[2].label, "ChatGPT 订阅");
        assert_eq!(groups[2].group_id, "99999999-1111-2222-3333-444444444444");
    }
}
