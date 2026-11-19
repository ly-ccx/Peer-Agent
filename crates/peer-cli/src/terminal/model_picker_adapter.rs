//! Adapter bridging `peer_runtime::model_catalog` into pure `peer_tui::ModelPickerGroup`s.
//!
//! Read-only projection: never reads credentials, never invokes providers, never merges
//! same-name models across distinct record IDs (model-picker.md).

use peer_tui::{ModelPickerGroup, ModelPickerOption};
use std::{collections::BTreeMap, path::Path};

pub(super) fn load_picker_groups(home: &Path) -> Result<Vec<ModelPickerGroup>, &'static str> {
    let entries = peer_runtime::model_catalog::load(Some(home)).map_err(|e| e.code)?;
    let mut grouped: BTreeMap<String, Vec<ModelPickerOption>> = BTreeMap::new();
    for (idx, entry) in entries.into_iter().enumerate() {
        let record_id = entry
            .entry_id
            .clone()
            .unwrap_or_else(|| format!("{}::{}::{}", entry.provider_id, entry.model_id, idx));
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
            display_name: entry.display_name,
            available: entry.available,
            supports_reasoning,
            efforts: entry.supported_reasoning_efforts,
            badges,
        };
        grouped.entry(entry.provider_id).or_default().push(opt);
    }
    Ok(grouped
        .into_iter()
        .map(|(provider_id, models)| ModelPickerGroup {
            group_id: provider_id.clone(),
            label: provider_id,
            models,
        })
        .collect())
}
