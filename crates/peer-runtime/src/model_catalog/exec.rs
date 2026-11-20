//! Ordinary exec selection over the existing catalog and v2 model document.
//! This is read-only identity resolution, not credential access or tool authority.
use super::*;
#[derive(Debug)]
pub struct ExecSelectionError {
    pub code: &'static str,
    pub detail: String,
    pub kind: ExecSelectionErrorKind,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecSelectionErrorKind {
    InvalidSelection,
    ConfigurationUnavailable,
}
fn error(code: &'static str, detail: impl Into<String>) -> ExecSelectionError {
    ExecSelectionError {
        code,
        detail: detail.into(),
        kind: ExecSelectionErrorKind::InvalidSelection,
    }
}
fn configuration_error(code: &'static str, detail: impl Into<String>) -> ExecSelectionError {
    ExecSelectionError {
        code,
        detail: detail.into(),
        kind: ExecSelectionErrorKind::ConfigurationUnavailable,
    }
}
pub struct ExecSelection {
    pub selection: Value,
    pub entry: ModelCatalogEntry,
}
pub fn resolve_exact_session_model(
    home: &Path,
    provider: &str,
    model: &str,
    effort: Option<&str>,
) -> Result<ExecSelection, ExecSelectionError> {
    build_selection(home, effort, false, |entries, _| {
        let mut matches = entries.iter().filter(|entry| {
            entry.available && entry.provider_id == provider && entry.model_id == model
        });
        let first = matches.next().ok_or_else(|| {
            error(
                "model_selection_unavailable",
                "Unknown or unavailable model",
            )
        })?;
        if matches.next().is_some() {
            return Err(error(
                "model_selection_ambiguous",
                "Ambiguous model identity",
            ));
        }
        Ok(first)
    })
}

pub fn resolve_exec(
    home: &Path,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    fast: bool,
) -> Result<ExecSelection, ExecSelectionError> {
    build_selection(home, effort, fast, |catalog, preferred| {
        resolve_catalog(catalog, preferred, provider, model)
    })
}

struct LoadedCatalog {
    catalog: Vec<ModelCatalogEntry>,
    flat: Vec<Value>,
    preferred: Option<String>,
}

fn load_catalog_state(home: &Path) -> Result<LoadedCatalog, ExecSelectionError> {
    let catalog = load(Some(home)).map_err(|e| configuration_error(e.code, e.code))?;
    if catalog.is_empty() {
        return Err(configuration_error(
            "model_not_configured",
            "model is not configured",
        ));
    }
    let document = if catalog.iter().all(|e| e.entry_id.is_none()) {
        None
    } else {
        Some(
            model_config::read(&home.join("llm-providers.json"))
                .map_err(|e| configuration_error(e.code, e.code))?,
        )
    };
    let flat = document
        .as_ref()
        .map(rows)
        .transpose()
        .map_err(|e| configuration_error(e.code, e.code))?
        .unwrap_or_default();
    let preferred = flat
        .iter()
        .find(|row| {
            row["isDefault"] == true
                && catalog
                    .iter()
                    .any(|e| e.entry_id.as_deref() == row["id"].as_str())
        })
        .and_then(|v| v["id"].as_str())
        .map(str::to_owned);
    Ok(LoadedCatalog {
        catalog,
        flat,
        preferred,
    })
}

fn row_for_entry<'a>(entry: &ModelCatalogEntry, flat: &'a [Value]) -> Option<&'a Value> {
    entry
        .entry_id
        .as_deref()
        .and_then(|id| flat.iter().find(|r| r["id"] == id))
}

fn family_for_entry(entry: &ModelCatalogEntry, row: Option<&Value>) -> String {
    row.and_then(|r| text(r, "providerType").or_else(|| text(r, "provider")))
        .unwrap_or(&entry.provider_id)
        .to_lowercase()
}

fn finish_selection(
    entry: ModelCatalogEntry,
    row: Option<&Value>,
    effort: &str,
    fast: bool,
) -> ExecSelection {
    let family = family_for_entry(&entry, row);
    let mut selection = json!({
        "providerId": entry.provider_id,
        "modelId": entry.model_id,
        "family": family,
        "reasoningEffort": effort,
        "fastMode": fast,
    });
    if let Some(id) = &entry.entry_id {
        selection["modelProviderId"] = json!(id);
    }
    ExecSelection { selection, entry }
}

fn read_settings_model_routing(home: &Path) -> Option<Value> {
    const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
    let file = home.join("settings.json");
    let meta = std::fs::metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > MAX_SETTINGS_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(&file).ok()?;
    let doc: Value = serde_json::from_str(&raw).ok()?;
    doc.get("modelRouting").filter(|v| v.is_object()).cloned()
}

/// Resolve a role model using `profile.modelPolicy` and `<home>/settings.json` `modelRouting`,
/// while honoring explicit provider/model overrides first.
pub fn resolve_role_model(
    home: &Path,
    role: &str,
    project_policy: Option<&Value>,
    explicit_provider: Option<&str>,
    explicit_model: Option<&str>,
    explicit_effort: Option<&str>,
    fast: bool,
) -> Result<ExecSelection, ExecSelectionError> {
    if explicit_provider.is_some() || explicit_model.is_some() {
        return resolve_exec(
            home,
            explicit_provider,
            explicit_model,
            explicit_effort,
            fast,
        );
    }

    let LoadedCatalog {
        catalog,
        flat,
        preferred,
    } = load_catalog_state(home)?;
    let model_routing = read_settings_model_routing(home);

    let scope = project_policy
        .and_then(|p| p.get("scope"))
        .filter(|v| v.is_object());
    let allowed_ids: Vec<&str> = scope
        .and_then(|s| s["modelProviderIds"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(trim).filter(|s| !s.is_empty()))
        .collect();
    let allowed_families: Vec<String> = scope
        .and_then(|s| s["families"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| {
            v.as_str()
                .map(trim)
                .filter(|s| !s.is_empty())
                .map(str::to_lowercase)
        })
        .collect();
    let has_scope = !allowed_ids.is_empty() || !allowed_families.is_empty();

    let entry_in_scope = |entry: &ModelCatalogEntry| -> bool {
        if !allowed_ids.is_empty()
            && !entry
                .entry_id
                .as_deref()
                .is_some_and(|id| allowed_ids.contains(&id))
            && !allowed_ids.contains(&entry.provider_id.as_str())
        {
            return false;
        }
        if !allowed_families.is_empty() {
            let fam = family_for_entry(entry, row_for_entry(entry, &flat));
            if !allowed_families.iter().any(|f| f == &fam) {
                return false;
            }
        }
        true
    };

    let role_setting = project_policy
        .and_then(|p| p.get("overrides"))
        .and_then(|o| o.get(role))
        .filter(|v| v.is_object())
        .or_else(|| {
            model_routing
                .as_ref()
                .and_then(|r| r.get("roles"))
                .and_then(|roles| roles.get(role))
                .filter(|v| v.is_object())
        });

    let mut candidate_ids: Vec<&str> = Vec::new();
    let mut role_effort: Option<&str> = None;
    let mut force_model_default = false;
    let mut role_fast = fast;

    if let Some(setting) = role_setting {
        let tier = match text(setting, "mode") {
            Some("fixed") => {
                if let Some(id) = text(setting, "modelProviderId") {
                    candidate_ids.push(id);
                }
                None
            }
            Some("tier") => {
                let tier_obj = text(setting, "tier").and_then(|tier_name| {
                    model_routing
                        .as_ref()
                        .and_then(|r| r.get("tiers"))
                        .and_then(|t| t.get(tier_name))
                        .filter(|v| v.is_object())
                });
                if let Some(t) = tier_obj {
                    if let Some(primary) = text(t, "primary") {
                        candidate_ids.push(primary);
                    }
                    if let Some(fallbacks) = t["fallbacks"].as_array() {
                        for fb in fallbacks {
                            if let Some(id) = fb.as_str().map(trim).filter(|s| !s.is_empty())
                                && !candidate_ids.contains(&id)
                            {
                                candidate_ids.push(id);
                            }
                        }
                    }
                }
                tier_obj
            }
            Some("auto") => {
                if let Some(pool) = setting["pool"].as_array() {
                    for item in pool {
                        if let Some(id) = item.as_str().map(trim).filter(|s| !s.is_empty())
                            && !candidate_ids.contains(&id)
                        {
                            candidate_ids.push(id);
                        }
                    }
                }
                None
            }
            _ => None,
        };

        match setting.get("reasoningEffort") {
            Some(Value::Null) => {
                force_model_default = true;
            }
            Some(Value::String(s)) if !trim(s).is_empty() => {
                role_effort = Some(trim(s));
            }
            _ => {
                role_effort = tier.and_then(|t| text(t, "reasoningEffort"));
            }
        }
        role_fast = setting["fastMode"]
            .as_bool()
            .or_else(|| tier.and_then(|t| t["fastMode"].as_bool()))
            .unwrap_or(fast);
    }

    let matched_entry = candidate_ids.iter().find_map(|cand_id| {
        catalog.iter().find(|entry| {
            entry.available
                && (entry.entry_id.as_deref() == Some(*cand_id) || entry.provider_id == *cand_id)
                && entry_in_scope(entry)
        })
    });

    let chosen = match matched_entry {
        Some(entry) => entry.clone(),
        None => {
            if has_scope {
                let scoped: Vec<ModelCatalogEntry> = catalog
                    .iter()
                    .filter(|e| e.available && entry_in_scope(e))
                    .cloned()
                    .collect();
                if scoped.is_empty() {
                    return Err(error(
                        "model_selection_unavailable",
                        "no configured model satisfies project modelPolicy scope",
                    ));
                }
                resolve_catalog(&scoped, preferred.as_deref(), None, None)?.clone()
            } else {
                resolve_catalog(&catalog, preferred.as_deref(), None, None)?.clone()
            }
        }
    };

    let row = row_for_entry(&chosen, &flat);
    let desired_effort = if force_model_default {
        chosen.default_reasoning_effort.as_str()
    } else {
        role_effort
            .or(explicit_effort)
            .unwrap_or(chosen.default_reasoning_effort.as_str())
    };
    let final_effort = if chosen
        .supported_reasoning_efforts
        .iter()
        .any(|v| v == desired_effort)
    {
        desired_effort.to_owned()
    } else {
        chosen.default_reasoning_effort.clone()
    };
    let final_fast = role_fast
        && row
            .is_some_and(|r| matches!(text(r, "authMethod"), Some("oauth_chatgpt" | "oauth_grok")));

    Ok(finish_selection(chosen, row, &final_effort, final_fast))
}
fn build_selection(
    home: &Path,
    effort: Option<&str>,
    fast: bool,
    choose: impl for<'a> FnOnce(
        &'a [ModelCatalogEntry],
        Option<&str>,
    ) -> Result<&'a ModelCatalogEntry, ExecSelectionError>,
) -> Result<ExecSelection, ExecSelectionError> {
    let LoadedCatalog {
        catalog,
        flat,
        preferred,
    } = load_catalog_state(home)?;
    let entry = choose(&catalog, preferred.as_deref())?.clone();
    let effort = effort.unwrap_or(&entry.default_reasoning_effort).to_owned();
    if !entry
        .supported_reasoning_efforts
        .iter()
        .any(|v| v == &effort)
    {
        return Err(error(
            "model_effort_unsupported",
            format!(
                "unsupported --effort {effort} for {}::{}",
                entry.provider_id, entry.model_id
            ),
        ));
    }
    let row = row_for_entry(&entry, &flat);
    if fast
        && !row
            .is_some_and(|r| matches!(text(r, "authMethod"), Some("oauth_chatgpt" | "oauth_grok")))
    {
        return Err(error(
            "model_fast_unsupported",
            "--fast requires a configured ChatGPT or Grok OAuth channel",
        ));
    }
    Ok(finish_selection(entry, row, &effort, fast))
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
            .ok_or_else(|| configuration_error("model_not_configured", "model is not configured"));
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

    #[test]
    fn resolve_role_model_respects_settings_routing_and_project_policy_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let providers = json!({
            "version": 2,
            "channels": [
                {
                    "id": "openai-ch",
                    "name": "OpenAI",
                    "provider": "openai",
                    "providerType": "openai",
                    "authMethod": "api_key",
                    "apiKeyConfigured": true,
                    "enabled": true
                },
                {
                    "id": "anthropic-ch",
                    "name": "Anthropic",
                    "provider": "anthropic",
                    "providerType": "anthropic",
                    "authMethod": "api_key",
                    "apiKeyConfigured": true,
                    "enabled": true
                }
            ],
            "models": [
                {
                    "id": "openai-default",
                    "groupId": "openai-ch",
                    "model": "gpt-5",
                    "isDefault": true,
                    "enabled": true,
                    "reasoningEffortLevels": ["low", "medium", "high"],
                    "reasoningDefaultEffort": "medium"
                },
                {
                    "id": "anthropic-strong",
                    "groupId": "anthropic-ch",
                    "model": "claude-sonnet",
                    "isDefault": false,
                    "enabled": true,
                    "reasoningEffortLevels": ["low", "high"],
                    "reasoningDefaultEffort": "high"
                }
            ]
        });
        std::fs::write(
            dir.path().join("llm-providers.json"),
            serde_json::to_string(&providers).unwrap(),
        )
        .unwrap();
        let settings = json!({
            "modelRouting": {
                "tiers": {
                    "strong": {
                        "primary": "anthropic-strong",
                        "fallbacks": ["openai-default"],
                        "reasoningEffort": "high"
                    }
                },
                "roles": {
                    "project_agent": {
                        "mode": "tier",
                        "tier": "strong"
                    },
                    "session_worker": {
                        "mode": "fixed",
                        "modelProviderId": "openai-default",
                        "reasoningEffort": "low"
                    }
                }
            }
        });
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();

        // 1. Global settings tier routing picks anthropic-strong with tier effort
        let bot =
            resolve_role_model(dir.path(), "project_agent", None, None, None, None, false).unwrap();
        assert_eq!(bot.selection["modelProviderId"], "anthropic-strong");
        assert_eq!(bot.selection["reasoningEffort"], "high");

        // 2. Project policy override + scope allowlist picks openai-default cleanly
        let policy = json!({
            "scope": {
                "families": ["openai"]
            },
            "overrides": {
                "project_agent": {
                    "mode": "fixed",
                    "modelProviderId": "openai-default",
                    "reasoningEffort": null
                }
            }
        });
        let scoped = resolve_role_model(
            dir.path(),
            "project_agent",
            Some(&policy),
            None,
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(scoped.selection["modelProviderId"], "openai-default");
        assert_eq!(scoped.selection["reasoningEffort"], "medium");

        // 3. Explicit provider/model wins over role routing
        let explicit = resolve_role_model(
            dir.path(),
            "project_agent",
            Some(&policy),
            Some("anthropic-ch"),
            Some("claude-sonnet"),
            Some("low"),
            false,
        )
        .unwrap();
        assert_eq!(explicit.selection["modelProviderId"], "anthropic-strong");
        assert_eq!(explicit.selection["reasoningEffort"], "low");
    }
}
