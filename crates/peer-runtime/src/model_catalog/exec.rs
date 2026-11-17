//! Ordinary exec selection over the existing catalog and v2 model document.
//! This is read-only identity resolution, not credential access or tool authority.
use super::*;
#[derive(Debug)]
pub struct ExecSelectionError {
    pub code: &'static str,
    pub detail: String,
}
fn error(code: &'static str, detail: impl Into<String>) -> ExecSelectionError {
    ExecSelectionError {
        code,
        detail: detail.into(),
    }
}
pub struct ExecSelection {
    pub selection: Value,
    pub entry: ModelCatalogEntry,
}
pub fn resolve_exec(
    home: &Path,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    fast: bool,
) -> Result<ExecSelection, ExecSelectionError> {
    let catalog = load(Some(home)).map_err(|e| error(e.code, e.code))?;
    if catalog.is_empty() {
        return Err(error("model_not_configured", "model is not configured"));
    }
    let document = if catalog.iter().all(|e| e.entry_id.is_none()) {
        None
    } else {
        Some(
            model_config::read(&home.join("llm-providers.json"))
                .map_err(|e| error(e.code, e.code))?,
        )
    };
    let flat = document
        .as_ref()
        .map(rows)
        .transpose()
        .map_err(|e| error(e.code, e.code))?
        .unwrap_or_default();
    let preferred = flat
        .iter()
        .find(|row| {
            row["isDefault"] == true
                && catalog
                    .iter()
                    .any(|e| e.entry_id.as_deref() == row["id"].as_str())
        })
        .and_then(|v| v["id"].as_str());
    let entry = resolve_catalog(&catalog, preferred, provider, model)?.clone();
    let effort = effort.unwrap_or(&entry.default_reasoning_effort);
    if !entry
        .supported_reasoning_efforts
        .iter()
        .any(|v| v == effort)
    {
        return Err(error(
            "model_effort_unsupported",
            format!(
                "unsupported --effort {effort} for {}::{}",
                entry.provider_id, entry.model_id
            ),
        ));
    }
    let row = entry
        .entry_id
        .as_deref()
        .and_then(|id| flat.iter().find(|r| r["id"] == id));
    let family = row
        .and_then(|r| text(r, "providerType").or_else(|| text(r, "provider")))
        .unwrap_or(&entry.provider_id)
        .to_lowercase();
    if fast
        && !row
            .is_some_and(|r| matches!(text(r, "authMethod"), Some("oauth_chatgpt" | "oauth_grok")))
    {
        return Err(error(
            "model_fast_unsupported",
            "--fast requires a configured ChatGPT or Grok OAuth channel",
        ));
    }
    let mut selection = json!({"providerId":entry.provider_id,"modelId":entry.model_id,"family":family,"reasoningEffort":effort,"fastMode":fast});
    if let Some(id) = &entry.entry_id {
        selection["modelProviderId"] = json!(id);
    }
    Ok(ExecSelection { selection, entry })
}
pub fn resolve_catalog<'a>(
    catalog: &'a [ModelCatalogEntry],
    preferred: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<&'a ModelCatalogEntry, ExecSelectionError> {
    if provider.is_none() && model.is_none() {
        return catalog
            .iter()
            .find(|e| e.available && e.entry_id.as_deref() == preferred && preferred.is_some())
            .or_else(|| catalog.iter().find(|e| e.available))
            .ok_or_else(|| error("model_not_configured", "model is not configured"));
    }
    let model = model.map(trim);
    let qualified = model
        .and_then(|m| m.split_once("::"))
        .filter(|(p, m)| !trim(p).is_empty() && !trim(m).is_empty());
    let qualified_provider = qualified.map(|(p, _)| trim(p));
    if provider.is_some() && qualified_provider.is_some() && provider != qualified_provider {
        return Err(error(
            "model_selection_conflict",
            "--provider conflicts with --model",
        ));
    }
    let provider = provider.or(qualified_provider);
    let model = qualified.map(|(_, m)| trim(m)).or(model);
    let candidates = catalog
        .iter()
        .filter(|e| provider.is_none_or(|p| e.provider_id == p || e.entry_id.as_deref() == Some(p)))
        .filter(|e| model.is_none_or(|m| e.model_id == m))
        .collect::<Vec<_>>();
    if candidates.len() == 1 {
        return Ok(candidates[0]);
    }
    let available = candidates
        .iter()
        .filter(|e| e.available)
        .copied()
        .collect::<Vec<_>>();
    if available.len() == 1 {
        return Ok(available[0]);
    }
    if candidates.is_empty() {
        return Err(error(
            "model_selection_unavailable",
            "unknown --provider or --model",
        ));
    }
    let choices = if available.is_empty() {
        candidates
    } else {
        available
    };
    Err(error(
        "model_selection_ambiguous",
        format!(
            "model is ambiguous; use --provider <id> or --model <provider>::<model>:\n{}",
            choices
                .iter()
                .map(|e| format!("  {}::{}", e.provider_id, e.model_id))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(v: &Value) -> ModelCatalogEntry {
        ModelCatalogEntry {
            provider_id: v["providerId"].as_str().unwrap().into(),
            model_id: v["modelId"].as_str().unwrap().into(),
            entry_id: v["entryId"].as_str().map(Into::into),
            display_name: "model".into(),
            context_window: None,
            supports_tools: true,
            supported_reasoning_efforts: vec!["default".into()],
            default_reasoning_effort: "default".into(),
            available: v["available"].as_bool().unwrap(),
        }
    }
    #[test]
    fn published_model_disambiguation_matches_actual_ts_catalog_oracle() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/ordinary-exec.json"
        ))
        .unwrap();
        let cases = fixture["modelCases"].as_array().unwrap();
        assert_eq!(cases.len(), 11);
        for case in cases {
            let catalog = case["catalog"]
                .as_array()
                .unwrap()
                .iter()
                .map(entry)
                .collect::<Vec<_>>();
            let actual = resolve_catalog(
                &catalog,
                None,
                case["ref"]["provider"].as_str(),
                case["ref"]["model"].as_str(),
            );
            if case["expected"]["ok"] == true {
                let selected = actual.unwrap();
                assert_eq!(
                    selected.provider_id,
                    case["expected"]["entry"]["providerId"]
                );
                assert_eq!(selected.model_id, case["expected"]["entry"]["modelId"]);
                assert_eq!(
                    selected.entry_id.as_deref(),
                    case["expected"]["entry"]["entryId"].as_str()
                );
            } else {
                let expected = case["expected"]["message"].as_str().unwrap();
                let actual = actual.unwrap_err();
                let code = if expected.contains("conflicts") {
                    "model_selection_conflict"
                } else if expected.contains("ambiguous") {
                    "model_selection_ambiguous"
                } else {
                    "model_selection_unavailable"
                };
                assert_eq!(actual.code, code, "{case}");
                if expected.contains("ambiguous") {
                    for choice in expected.lines().skip(1) {
                        assert!(actual.detail.contains(choice));
                    }
                }
            }
        }
    }
    #[test]
    fn implicit_default_respects_ready_preference_without_guessing_explicit_ambiguity() {
        let mut entries = vec![
            entry(&json!({"providerId":"a","modelId":"model","entryId":"a","available":true})),
            entry(&json!({"providerId":"b","modelId":"model","entryId":"b","available":true})),
        ];
        assert_eq!(
            resolve_catalog(&entries, Some("b"), None, None)
                .unwrap()
                .provider_id,
            "b"
        );
        assert_eq!(
            resolve_catalog(&entries, Some("b"), None, Some("model"))
                .unwrap_err()
                .code,
            "model_selection_ambiguous"
        );
        entries[1].available = false;
        assert_eq!(
            resolve_catalog(&entries, Some("b"), None, None)
                .unwrap()
                .provider_id,
            "a"
        );
        entries[0].available = false;
        assert_eq!(
            resolve_catalog(&entries, None, None, None)
                .unwrap_err()
                .code,
            "model_not_configured"
        );
    }
}
