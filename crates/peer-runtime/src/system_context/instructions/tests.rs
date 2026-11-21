use super::*;
use sha2::{Digest, Sha256};
#[test]
fn actual_ts_source_rendering_metadata_and_checksums_match_native_files() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/contracts/native-cli/project-instructions.json"
    ))
    .unwrap();
    for c in data["cases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        for (file, content) in c["files"].as_object().unwrap() {
            std::fs::write(root.path().join(file), content.as_str().unwrap()).unwrap();
        }
        let instructions = ProjectInstructions::observe(root.path()).unwrap();
        let sections = instructions.sections();
        let normalized: Value = serde_json::from_str(
            &serde_json::to_string(&sections)
                .unwrap()
                .replace(root.path().to_str().unwrap(), "/synthetic/workspace"),
        )
        .unwrap();
        assert_eq!(normalized, c["expected"]["sections"]);
        let rendered = sections
            .iter()
            .map(|s| s["content"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(
            format!("{:x}", Sha256::digest(rendered.as_bytes())),
            c["expected"]["snapshot"]["renderedHash"]
        );
    }
}
#[test]
fn changed_invalid_and_oversized_sources_fail_without_rewriting_the_file() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("AGENTS.md");
    std::fs::write(&file, "original").unwrap();
    assert!(matches!(
        ProjectInstructions::observe_inner(
            &InstructionInput {
                workspace: root.path(),
                data_home: root.path(),
                include_global: false,
                config: &[],
                target_paths: &[]
            },
            &CancellationToken::new(),
            |p| std::fs::write(p, "changed longer guidance").unwrap()
        ),
        Err("context_instruction_changed")
    ));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "changed longer guidance"
    );
    for (bytes, error) in [
        (vec![0xff], "context_instruction_invalid_utf8"),
        (vec![b'x'; 1024 * 1024 + 1], "context_instruction_limit"),
    ] {
        std::fs::write(&file, &bytes).unwrap();
        assert!(matches!(ProjectInstructions::observe(root.path()),Err(e) if e==error));
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }
}

#[test]
fn total_source_budget_and_mid_observation_cancel_preserve_originals() {
    let root = tempfile::tempdir().unwrap();
    for name in [
        "AGENTS.md",
        "CLAUDE.md",
        "a/AGENTS.md",
        "a/CLAUDE.md",
        "a/b/AGENTS.md",
    ] {
        let file = root.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, vec![b'x'; 1024 * 1024]).unwrap();
    }
    let targets = [PathBuf::from("a/b/missing")];
    let input = InstructionInput {
        workspace: root.path(),
        data_home: root.path(),
        include_global: false,
        config: &[],
        target_paths: &targets,
    };
    assert!(matches!(
        ProjectInstructions::observe_input(&input, &CancellationToken::new()),
        Err("context_instruction_limit")
    ));
    let cancel = CancellationToken::new();
    assert!(matches!(
        ProjectInstructions::observe_inner(&input, &cancel, |_| cancel.cancel()),
        Err("cancelled")
    ));
    assert_eq!(
        std::fs::metadata(root.path().join("AGENTS.md"))
            .unwrap()
            .len(),
        1024 * 1024
    );
    let long = PathBuf::from((0..64).map(|_| "dir").collect::<Vec<_>>().join("/"));
    assert!(matches!(
        ProjectInstructions::observe_input(
            &InstructionInput {
                target_paths: &[long],
                ..input
            },
            &CancellationToken::new()
        ),
        Err("context_instruction_limit")
    ));
}

#[test]
fn settings_are_read_only_and_unsupported_values_do_not_become_defaults() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("settings.json");
    for (raw, code) in [
        ("{broken", "context_settings_invalid"),
        ("[]", "context_settings_invalid"),
        (
            "{\"schemaVersion\":4}",
            "context_settings_schema_unsupported",
        ),
        (
            "{\"schemaVersion\":-1}",
            "context_settings_schema_unsupported",
        ),
        ("{\"replyLanguage\":true}", "context_settings_invalid"),
        ("{\"themeMode\":false}", "context_settings_invalid"),
        (
            "{\"localAccessLevel\":\"unknown\"}",
            "context_settings_invalid",
        ),
        ("{\"projectAgent\":true}", "context_settings_invalid"),
        (
            "{\"projectAgent\":{\"shell\":\"classic\"}}",
            "native_capability_inventory_unsupported",
        ),
        (
            "{\"projectAgent\":{\"interactiveResults\":true}}",
            "native_capability_inventory_unsupported",
        ),
        (
            "{\"projectAgent\":{\"shellIntroDismissed\":\"yes\"}}",
            "context_settings_invalid",
        ),
        ("{\"workspaces\":\"bad\"}", "context_settings_invalid"),
        ("{\"appearance\":true}", "context_settings_invalid"),
        (
            "{\"projectAgent\":{\"quietHours\":\"bad\"}}",
            "context_settings_invalid",
        ),
    ] {
        std::fs::write(&file, raw).unwrap();
        assert!(
            matches!(ProjectInstructions::observe_host(root.path(),root.path(),&CancellationToken::new()),Err(e) if e==code)
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), raw);
    }
    let desktop_shared = serde_json::json!({
        "schemaVersion": 3,
        "locale": "zh-CN",
        "activeWorkspace": "/tmp/ws",
        "workspaces": [{"id": "ws-1", "path": "/tmp/ws"}],
        "appearance": {"mode": "dark"},
        "appshots": {"enabled": false},
        "appMode": "work",
        "composerDrafts": {},
        "developer": {"projectAgentMode": false},
        "effort": "high",
        "fallbackVision": {"providerId": "p1"},
        "inputPrediction": {"enabled": false},
        "localAccessLevel": "full_local",
        "memory": {"enabled": true},
        "modelRouting": {"roles": {}, "tiers": {}},
        "remoteAccess": {"enabled": false},
        "updateChannel": "beta",
        "workbench": {"open": false},
        "projectAgent": {
            "shell": "bots",
            "shellIntroPending": false,
            "shellIntroDismissed": true,
            "proactivity": "standard",
            "quietHours": {"enabled": false, "start": "22:00", "end": "08:00"},
            "digestTime": "09:00",
            "concurrency": 4
        }
    });
    let desktop_raw = serde_json::to_string(&desktop_shared).unwrap();
    std::fs::write(&file, &desktop_raw).unwrap();
    let desktop_result =
        ProjectInstructions::observe_host(root.path(), root.path(), &CancellationToken::new())
            .unwrap();
    assert_eq!(desktop_result.sections().len(), 2);
    let rendered_desktop = serde_json::to_string(&desktop_result.sections()).unwrap();
    for meta_key in [
        "workbench",
        "modelRouting",
        "inputPrediction",
        "fallbackVision",
        "remoteAccess",
    ] {
        assert!(!rendered_desktop.contains(meta_key));
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), desktop_raw);

    std::fs::write(&file, "{\"schemaVersion\":3e0,\"locale\":\"en-US\"}").unwrap();
    let result =
        ProjectInstructions::observe_host(root.path(), root.path(), &CancellationToken::new())
            .unwrap();
    assert_eq!(result.sections().len(), 2);
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(matches!(
        ProjectInstructions::observe_host(root.path(), root.path(), &CancellationToken::new()),
        Err("context_settings_unavailable")
    ));
}

#[test]
fn desktop_host_tolerates_desktop_settings_and_respects_config_override() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("settings.json");
    std::fs::write(
        &file,
        serde_json::to_string(&serde_json::json!({
            "schemaVersion": 3,
            "locale": "zh-CN",
            "replyLanguage": "auto",
            "gitBranchPrefix": "Custom/",
            "projectAgent": {
                "shell": "classic",
                "interactiveResults": true,
            },
            "shortcuts": { "quickChat": "Alt+Space" },
            "resourceWindowReadingHistory": { "a": 1 },
        }))
        .unwrap(),
    )
    .unwrap();

    // Strict CLI host still rejects unported Desktop keys.
    assert!(matches!(
        ProjectInstructions::observe_host(root.path(), root.path(), &CancellationToken::new()),
        Err("native_capability_inventory_unsupported")
    ));

    // Desktop host accepts them, omits replyLanguage when "auto", and preserves gitBranchPrefix.
    let desktop = ProjectInstructions::observe_desktop_host(
        root.path(),
        root.path(),
        None,
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(desktop.sections().len(), 1);
    let rendered = serde_json::to_string(&desktop.sections()).unwrap();
    assert!(rendered.contains("Custom/"));
    assert!(!rendered.contains("Reply Language"));

    // Explicit config_override takes precedence.
    let override_items = [ConfigInstruction {
        id: "settings.custom".into(),
        title: "Custom Rule".into(),
        content: "Follow desktop override.".into(),
        source: Some("settings.custom".into()),
        priority: 0,
    }];
    let overridden = ProjectInstructions::observe_desktop_host(
        root.path(),
        root.path(),
        Some(&override_items),
        &CancellationToken::new(),
    )
    .unwrap();
    let rendered_override = serde_json::to_string(&overridden.sections()).unwrap();
    assert!(rendered_override.contains("Follow desktop override."));
    assert!(!rendered_override.contains("Custom/"));

    // Corrupt JSON and directory settings.json still fail cleanly.
    std::fs::write(&file, "{broken").unwrap();
    assert!(matches!(
        ProjectInstructions::observe_desktop_host(
            root.path(),
            root.path(),
            None,
            &CancellationToken::new(),
        ),
        Err("context_settings_invalid")
    ));
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(matches!(
        ProjectInstructions::observe_desktop_host(
            root.path(),
            root.path(),
            None,
            &CancellationToken::new(),
        ),
        Err("context_settings_unavailable")
    ));
}
