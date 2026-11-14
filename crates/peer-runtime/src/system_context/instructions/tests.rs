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
        (
            "{\"localAccessLevel\":\"full_local\"}",
            "native_capability_inventory_unsupported",
        ),
    ] {
        std::fs::write(&file, raw).unwrap();
        assert!(
            matches!(ProjectInstructions::observe_host(root.path(),root.path(),&CancellationToken::new()),Err(e) if e==code)
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), raw);
    }
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
