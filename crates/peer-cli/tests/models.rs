use serde_json::Value;
use std::process::{Command, Stdio};
#[test]
fn original_models_entry_matches_actual_ts_without_js_helper_or_config_writes() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/model-catalog.json"
    ))
    .unwrap();
    for case in data["cases"].as_array().unwrap() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("llm-providers.json");
        let original = case
            .get("document")
            .map(|doc| serde_json::to_vec(doc).unwrap());
        if let Some(bytes) = &original {
            std::fs::write(&path, bytes).unwrap();
        }
        let mut command = Command::new(env!("CARGO_BIN_EXE_peer-native"));
        command
            .arg("models")
            .env_clear()
            .env("PEER_AGENT_HOME", home.path())
            .env("PATH", "/nonexistent")
            .env(
                "PEER_CREDENTIAL_HELPER_PATH",
                "/nonexistent/forbidden-helper",
            )
            .stdin(Stdio::null());
        for (key, value) in case["env"].as_object().into_iter().flatten() {
            command.env(key, value.as_str().unwrap());
        }
        let out = command.output().unwrap();
        assert_eq!(
            out.status.code(),
            case["expected"]["exitCode"].as_i64().map(|v| v as i32),
            "{}: {}",
            case["name"],
            String::from_utf8_lossy(&out.stderr)
        );
        for (actual, key) in [(&out.stdout, "stdout"), (&out.stderr, "stderr")] {
            let lines = case["expected"][key].as_array().unwrap();
            let expected = lines
                .iter()
                .map(|v| format!("{}\n", v.as_str().unwrap()))
                .collect::<String>();
            assert_eq!(
                String::from_utf8_lossy(actual),
                expected,
                "{} {key}",
                case["name"]
            );
        }
        assert_eq!(std::fs::read(path).ok(), original);
        assert_eq!(
            std::fs::read_dir(home.path()).unwrap().count(),
            usize::from(case.get("document").is_some())
        );
    }
}
#[test]
fn unsafe_terminal_text_and_future_configuration_do_not_escape_or_get_overwritten() {
    for value in [
        serde_json::json!({"version":99,"channels":[],"models":[]}),
        serde_json::json!([{"id":"group","model":"model","name":"bad\u{1b}]52;clipboard","apiKeyConfigured":true}]),
    ] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("llm-providers.json");
        let original = value.to_string();
        std::fs::write(&file, &original).unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_peer-native"))
            .arg("models")
            .env_clear()
            .env("PEER_AGENT_HOME", root.path())
            .env("PATH", "/nonexistent")
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!out.stderr.contains(&0x1b));
        assert_eq!(std::fs::read_to_string(file).unwrap(), original);
    }
}
