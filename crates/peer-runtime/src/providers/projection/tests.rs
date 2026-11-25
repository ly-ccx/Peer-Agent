use super::*;

fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../packages/protocol/contracts/native-cli/runtime-projection.json"
    ))
    .unwrap()
}

#[test]
fn every_runtime_mode_matches_actual_ts_scope_validation_and_membership() {
    let data = contract();
    let mut checked = 0;
    for case in data["cases"].as_array().unwrap() {
        for expected in case["expected"].as_array().unwrap() {
            let mode = expected["mode"].as_str().unwrap().parse().unwrap();
            let actual = available(&case["manifest"], mode);
            if let Some(error) = expected["error"].as_str() {
                assert_eq!(
                    actual.map_err(|e| e.0),
                    Err(error),
                    "{} / {mode:?}",
                    case["name"]
                );
            } else {
                assert_eq!(
                    actual.unwrap(),
                    expected["available"].as_bool().unwrap(),
                    "{} / {mode:?}",
                    case["name"]
                );
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 128);
    for unknown in ["", "CHAT", " chat", "future", "verifier"] {
        assert_eq!(
            unknown.parse::<RuntimeMode>(),
            Err(HostError("runtime_mode_invalid"))
        );
    }
}

#[test]
fn mode_and_allowlist_intersection_blocks_real_provider_preparation() {
    let root = tempfile::tempdir().unwrap();
    let mut registry = ProviderRegistry::default();
    for mode in [
        RuntimeMode::Plan,
        RuntimeMode::Explorer,
        RuntimeMode::System,
        RuntimeMode::Compact,
    ] {
        let projection = registry.project_for_mode(mode, None).unwrap();
        for alias in ["write_file", "edit_file", "bash"] {
            assert!(matches!(
                registry.prepare(&projection, alias, json!({}), root.path(), root.path()),
                Err(HostError("tool_not_projected"))
            ));
        }
    }
    let allow = vec!["local.file.read".to_owned(), "local.shell.exec".to_owned()];
    let plan = registry
        .project_for_mode(RuntimeMode::Plan, Some(&allow))
        .unwrap();
    assert!(plan.capability("read_file").is_some());
    assert!(plan.capability("bash").is_none());
    assert!(plan.capability("git_query").is_none());
    let chat = registry
        .project_for_mode(RuntimeMode::Chat, Some(&allow))
        .unwrap();
    assert!(chat.capability("read_file").is_some());
    assert!(chat.capability("bash").is_some());
    assert_ne!(plan.id, chat.id);
    let empty = registry
        .project_for_mode(RuntimeMode::Goal, Some(&[]))
        .unwrap();
    assert_eq!(empty.definitions(), json!([]));
    assert!(matches!(
        registry.prepare(
            &empty,
            "read_file",
            json!({"path":"."}),
            root.path(),
            root.path()
        ),
        Err(HostError("tool_not_projected"))
    ));
    let absent = vec!["local.not-installed".to_owned()];
    assert_eq!(
        registry
            .project_for_mode(RuntimeMode::Chat, Some(&absent))
            .unwrap()
            .definitions(),
        json!([])
    );
}

#[test]
fn migrated_local_membership_matches_actual_tui_host_without_adding_missing_capabilities() {
    let data = contract();
    let registry = ProviderRegistry::default();
    for expected in data["localMembership"].as_array().unwrap() {
        let mode = expected["mode"].as_str().unwrap().parse().unwrap();
        let projection = registry.project_for_mode(mode, None).unwrap();
        let mut actual: Vec<_> = projection
            .tools
            .iter()
            .filter(|tool| {
                !matches!(
                    tool.capability.as_str(),
                    "local.tool-result.read" | "local.web.search"
                )
            })
            .map(|tool| tool.capability.clone())
            .collect();
        actual.sort();
        assert_eq!(json!(actual), expected["capabilities"], "{mode:?}");
        let has_web_search = projection
            .tools
            .iter()
            .any(|tool| tool.capability == "local.web.search");
        assert_eq!(
            has_web_search,
            matches!(
                mode,
                RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
            ),
            "native local.web.search membership for {mode:?}"
        );
    }
}

#[test]
fn default_goal_projection_preserves_existing_order_and_empty_allowlist_grants_no_visibility() {
    let registry = ProviderRegistry::default();
    let all = registry.project().unwrap();
    let goal = registry.project_for_mode(RuntimeMode::Goal, None).unwrap();
    assert_eq!(all.definitions(), goal.definitions());
    assert_eq!(all.id, goal.id);
    let empty = registry
        .project_for_mode(RuntimeMode::Goal, Some(&[]))
        .unwrap();
    assert_eq!(empty.definitions(), json!([]));
    assert_ne!(empty.id, goal.id);
    let ids = vec!["local.shell.exec".to_owned(), "local.file.read".to_owned()];
    let selected = registry
        .project_for_mode(RuntimeMode::Chat, Some(&ids))
        .unwrap();
    let retained: Vec<_> = all
        .tools
        .iter()
        .filter(|t| ids.contains(&t.capability))
        .map(|t| t.alias.as_str())
        .collect();
    assert_eq!(
        selected
            .tools
            .iter()
            .map(|t| t.alias.as_str())
            .collect::<Vec<_>>(),
        retained
    );
    assert_ne!(selected.id, goal.id);
}
