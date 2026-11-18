use super::*;
use std::{fs, os::unix::fs::symlink, path::PathBuf};

fn tool_result(fixture: &Ordinary, reply: &Value) -> Value {
    let id = reply["sessionId"].as_str().unwrap();
    let history = ConversationStore::new(fixture.home())
        .read_committed(id, None, 8 * 1024 * 1024)
        .unwrap();
    history
        .history
        .messages
        .iter()
        .flat_map(|message| message["segments"].as_array().into_iter().flatten())
        .find(|segment| segment["type"] == "tool-call")
        .unwrap()["result"]
        .clone()
}

fn artifact(root: &Path) -> PathBuf {
    let day = fs::read_dir(root).unwrap().next().unwrap().unwrap().path();
    fs::read_dir(day).unwrap().next().unwrap().unwrap().path()
}

fn invoke(fixture: &Ordinary, server: &Server) -> Output {
    fixture.run(
        Some(server),
        &[
            "--access",
            "full",
            "--tools",
            "bash",
            "--output-format",
            "json",
            "Observe synthetic shell",
        ],
        None,
    )
}

#[test]
fn public_shell_checks_artifact_directory_before_dispatch() {
    let fixture = Ordinary::new();
    fs::create_dir(fixture.home()).unwrap();
    let unrelated = fixture.root.path().join("unrelated-output");
    fs::create_dir(&unrelated).unwrap();
    symlink(&unrelated, fixture.home().join("shell-artifacts")).unwrap();
    let server = Server::new(vec![
        reply_tool("bash", json!({"command":"printf forbidden > dispatched"})),
        reply_text("Observed artifact admission failure."),
    ]);
    let out = invoke(&fixture, &server);
    let reply = fixture.assert_settled(&out, 2, 1);
    let result = tool_result(&fixture, &reply);
    assert_eq!(result["status"], "failed");
    assert_eq!(result["error"]["code"], "shell_artifact_unavailable");
    assert!(!fixture.workspace().join("dispatched").exists());
    assert!(fs::read_dir(unrelated).unwrap().next().is_none());
}

#[test]
fn public_shell_keeps_complete_artifact_under_quota_and_continues_after_preview_and_artifact_caps()
{
    let fixture = Ordinary::new();
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({
                "command": "printf '%0100000d' 0; printf '%02010000d' 0 >&2; printf done > finished",
                "timeoutMs": 10000,
            }),
        ),
        reply_text("Observed bounded streams."),
    ]);
    let out = invoke(&fixture, &server);
    let reply = fixture.assert_settled(&out, 2, 1);
    let result = tool_result(&fixture, &reply);
    assert_eq!(result["status"], "success");
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(result["output"]["nativeContentRef"].clone()).unwrap();
    let saved = peer_store::ToolArtifactStore::new(fixture.home())
        .read_window(
            reply["sessionId"].as_str().unwrap(),
            &reference,
            0,
            256 * 1024,
            &|| false,
        )
        .unwrap();
    assert!(saved.complete);
    let output: Value = serde_json::from_slice(&saved.bytes).unwrap();
    assert_eq!(output["exitCode"], 0);
    assert_eq!(output["truncated"], true);
    assert_eq!(output["stdout"].as_str().unwrap().len(), 65_536);
    assert_eq!(output["stderr"].as_str().unwrap().len(), 65_536);
    assert_eq!(
        fs::read(fixture.workspace().join("finished")).unwrap(),
        b"done"
    );
    let dir = artifact(&fixture.home().join("shell-artifacts"));
    assert_eq!(
        fs::read(dir.join("stdout.txt")).unwrap(),
        vec![b'0'; 100_000]
    );
    let raw = fs::read(dir.join("stderr.txt")).unwrap();
    assert!(raw.starts_with(&vec![b'0'; 2_000_000]));
    assert_eq!(&raw[2_000_000..], b"\n...[artifact truncated]\n");
    let metadata = get(dir.join("metadata.json"));
    assert_eq!(metadata["status"], "success");
    assert_eq!(metadata["managedProcessEnded"], true);
    assert_eq!(metadata["truncated"], true);
    assert!(
        result["evidence"]["artifactRefs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| {
                reference.as_str().is_some_and(|reference| {
                    reference.starts_with("local-shell-artifact://")
                        && reference.ends_with("/stdout")
                })
            })
    );
}
