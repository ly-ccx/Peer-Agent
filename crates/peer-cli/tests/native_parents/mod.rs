//! Recursive file creation must remain one governed, recoverable tool effect.
use super::*;
#[test]
fn write_creates_missing_parents_then_read_verifies_the_actual_file_and_evidence() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"new/deep/事实.txt","content":"saved 🦀\n"}),
        ),
        reply_tool("read_file", json!({"path":"new/deep/事实.txt"})),
        reply_text("Created and verified the file."),
    ]);
    let f = Fixture::new(&server);
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/new/deep/事实.txt")).unwrap(),
        "saved 🦀\n"
    );
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(receipt["toolCalls"], 2);
    let h = f.history();
    let tools: Vec<_> = h.iter().filter(|m| m["segments"].is_array()).collect();
    assert_eq!(tools.len(), 2);
    for m in &tools {
        assert_eq!(m["permissionGrants"][0]["granted"], true);
        assert_eq!(m["segments"][0]["result"]["status"], "success");
        assert!(m["segments"][0]["result"]["evidence"].is_object());
    }
    assert_eq!(
        tools[1]["segments"][0]["result"]["output"]["content"],
        "saved 🦀\n"
    );
}

#[test]
fn actual_ts_recursive_write_vectors_match_native_content_and_governed_results() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/file-parents.json"
    ))
    .unwrap();
    for c in data["cases"].as_array().unwrap() {
        let server = Server::new(vec![
            reply_tool("write_file", c["args"].clone()),
            reply_text("Write observation complete."),
        ]);
        let f = Fixture::new(&server);
        for d in c["directories"].as_array().into_iter().flatten() {
            std::fs::create_dir_all(f.root.path().join(d.as_str().unwrap())).unwrap();
        }
        if c["alias"].is_object() {
            std::os::unix::fs::symlink(
                f.root.path().join(c["alias"]["target"].as_str().unwrap()),
                f.root.path().join(c["alias"]["path"].as_str().unwrap()),
            )
            .unwrap();
        }
        if c["denied"] == true {
            let s = PolicyStore::new(f.root.path());
            let old = s.read_existing("w").unwrap();
            s.update_existing(
                "w",
                old.revision,
                peer_protocol::LocalAccessLevel::AskBeforeLocal,
                AT,
            )
            .unwrap();
        }
        let out = f.run();
        assert!(
            out.status.success(),
            "{}: {}",
            c["name"],
            String::from_utf8_lossy(&out.stderr)
        );
        let h = f.history();
        let message = h.iter().find(|m| m["segments"].is_array()).unwrap();
        let result = &message["segments"][0]["result"];
        let target = f.root.path().join("workspace").join(
            c["expected"]["output"]["path"]
                .as_str()
                .unwrap_or_else(|| c["args"]["path"].as_str().unwrap()),
        );
        assert_eq!(
            target.exists(),
            c["expected"]["targetExists"].as_bool().unwrap(),
            "{}",
            c["name"]
        );
        if c["denied"] == true {
            assert_eq!(result["status"], "denied");
            assert_eq!(message["permissionGrants"][0]["granted"], false);
            assert!(!f.root.path().join("workspace/denied").exists());
        } else {
            assert_eq!(result["status"], "success", "{}", c["name"]);
            assert_eq!(message["permissionGrants"][0]["granted"], true);
            let mut expected = c["expected"]["output"].clone();
            if let Some(path) = c["nativeOutputPath"].as_str() {
                expected["path"] = json!(path);
            }
            assert_eq!(result["output"], expected, "{}", c["name"]);
            assert_eq!(
                std::fs::read_to_string(target).unwrap(),
                c["expected"]["targetContent"].as_str().unwrap()
            );
            assert!(!f.root.path().join("workspace/unused").exists());
        }
        assert!(result["evidence"].is_object());
    }
}

#[test]
fn excessive_missing_parents_are_rejected_before_effect_and_allow_a_later_task() {
    let path = format!("{}out.txt", "p/".repeat(129));
    let server = Server::new(vec![
        reply_tool("write_file", json!({"path":path,"content":"never"})),
        reply_text("Later task."),
    ]);
    let f = Fixture::new(&server);
    let out = f.run();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("file_parent_limit"));
    assert!(!f.root.path().join("workspace/p").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}
