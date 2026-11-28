use super::*;
fn stream(wire: &str, kind: &str) -> String {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["wire"] == wire && c["kind"] == kind)
        .unwrap()["stream"]
        .as_str()
        .unwrap()
        .into()
}
fn assert_image(wire: &str, request: &Value) {
    let data = PNG.split_once(',').unwrap().1;
    match wire {
        "anthropic-messages" => assert!(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["content"].as_array().into_iter().flatten())
                .any(|p| p["type"] == "image"
                    && p["source"]["data"] == data
                    && p["source"]["media_type"] == "image/png")
        ),
        "gemini" => assert!(
            request["contents"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["parts"].as_array().into_iter().flatten())
                .any(|p| p["inlineData"]["data"] == data
                    && p["inlineData"]["mimeType"] == "image/png")
        ),
        "openai-responses" => assert!(
            request["input"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["content"].as_array().into_iter().flatten())
                .any(|p| p["type"] == "input_image" && p["image_url"] == PNG)
        ),
        _ => assert!(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|m| m["content"].as_array().into_iter().flatten())
                .any(|p| p["type"] == "image_url" && p["image_url"]["url"] == PNG)
        ),
    }
}
#[test]
fn all_standard_wires_send_saved_images_and_count_the_same_request_through_a_real_tool_turn() {
    for (wire, channel, provider) in [
        ("openai-chat", "openai-compatible", "openai"),
        ("openai-responses", "openai-compatible", "openai"),
        ("anthropic-messages", "anthropic", "anthropic"),
        ("gemini", "google-ai", "google"),
    ] {
        let server = Server::respond_counts(
            vec![stream(wire, "tool"), stream(wire, "text")],
            false,
            false,
            vec![20, 20],
        );
        let f = Fixture::new(&server);
        f.use_wire(wire, channel, provider);
        context_window(&f);
        let original = seed(&f, PNG);
        let out = f.run();
        assert!(
            out.status.success(),
            "{wire}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for r in requests.iter() {
            assert_image(wire, r);
        }
        let counts = server.count_requests.lock().unwrap();
        if matches!(wire, "anthropic-messages" | "gemini") {
            assert_eq!(counts.len(), 2);
            for (count, send) in counts.iter().zip(requests.iter()) {
                if wire == "gemini" {
                    assert_eq!(
                        count["generateContentRequest"]["contents"],
                        send["contents"]
                    );
                } else {
                    assert_eq!(count["messages"], send["messages"]);
                    assert_eq!(count["system"], send["system"]);
                }
            }
        } else {
            assert!(counts.is_empty());
        }
        let h = f.history();
        assert_eq!(h.iter().find(|m| m["id"] == "input-c").unwrap(), &original);
        let tool = h.iter().find(|m| has_tool_call(m)).unwrap();
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert!(tool["segments"][0]["result"]["evidence"].is_object());
        assert!(!tool.to_string().contains("iVBOR"));
    }
}
#[test]
fn url_images_are_not_fetched_and_an_explicit_provider_change_recovers_unrepresentable_history() {
    for (wire, channel, provider) in [
        ("anthropic-messages", "anthropic", "anthropic"),
        ("gemini", "google-ai", "google"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/image.png", listener.local_addr().unwrap());
        let server = Server::new(vec![reply_text(
            "Explicit selection accepts this saved URL.",
        )]);
        let f = Fixture::new(&server);
        f.use_wire(wire, channel, provider);
        context_window(&f);
        let original = seed(&f, &url);
        let out = f.run();
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("model_image_transport_unsupported"));
        assert!(server.requests.lock().unwrap().is_empty());
        assert!(server.count_requests.lock().unwrap().is_empty());
        assert_eq!(
            f.history().iter().find(|m| m["id"] == "input-c").unwrap(),
            &original
        );
        f.use_wire("openai-chat", "openai-compatible", "openai");
        let later = f.run();
        assert!(
            later.status.success(),
            "{}",
            String::from_utf8_lossy(&later.stderr)
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert!(
            server.requests.lock().unwrap()[0]
                .to_string()
                .contains(&url)
        );
        assert!(
            matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock),
            "the CLI must not fetch image URLs"
        );
        assert_eq!(
            f.history().iter().find(|m| m["id"] == "input-c").unwrap(),
            &original
        );
    }
}
#[test]
fn invalid_saved_images_and_request_pressure_make_no_model_request_and_preserve_input() {
    for pressure in [false, true] {
        let server = Server::new(vec![reply_text("Independent later task.")]);
        let f = Fixture::new(&server);
        if pressure {
            let store = peer_store::ConversationStore::new(f.root.path());
            for i in 0..3 {
                let h = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
                let row = json!({"id":format!("image-{i}"),"role":"user","content":"image","attachments":[{"kind":"image","dataUrl":format!("data:image/png;base64,{}","AAAA".repeat(190000))}]});
                store.commit_message(&h, &row, AT, None).unwrap();
            }
        } else {
            seed(&f, "data:image/png;base64,%%%");
        }
        let before = f.history();
        let out = if pressure {
            let mut cmd = f.command("exec", "p");
            cmd.env("PEER_NATIVE_TEST_REQUEST_LIMIT_BYTES", "2097152");
            cmd.output().unwrap()
        } else {
            f.run()
        };
        assert!(!out.status.success());
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(if pressure {
                "model_request_limit"
            } else {
                "model_image_invalid"
            }),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(server.requests.lock().unwrap().is_empty());
        assert!(server.count_requests.lock().unwrap().is_empty());
        assert_eq!(f.history(), before);
        f.seed("p2", "c2", "s2", "work2", "epoch2");
        let later = f.command("exec", "p2").output().unwrap();
        assert!(
            later.status.success(),
            "{}",
            String::from_utf8_lossy(&later.stderr)
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn compaction_cold_rebuild_keeps_current_saved_image_and_recounts_its_exact_request() {
    for (wire, channel, provider) in [
        ("anthropic-messages", "anthropic", "anthropic"),
        ("gemini", "google-ai", "google"),
    ] {
        let server = Server::respond_counts(
            vec![
                stream(wire, "tool"),
                stream(wire, "text"),
                stream(wire, "text"),
            ],
            false,
            false,
            vec![20, 900, 20],
        );
        let f = Fixture::new(&server);
        f.use_wire(wire, channel, provider);
        context_window(&f);
        let original = seed(&f, PNG);
        let out = f.run();
        assert!(
            out.status.success(),
            "{wire}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(receipt["contextAccounting"]["compactionEpoch"], 1);
        let h = f.history();
        assert_eq!(h.iter().find(|m| m["id"] == "input-c").unwrap(), &original);
        let cold = peer_runtime::canonical_history::project_history(&h).unwrap();
        assert!(cold.to_string().contains(PNG));
        let marker = h.iter().find(|m| m["_compaction"].is_object()).unwrap();
        assert_eq!(
            marker["_compaction"]["historySelection"]["retainedMessageIds"],
            json!(["input-c"])
        );
        let sends = server.requests.lock().unwrap();
        let counts = server.count_requests.lock().unwrap();
        assert_eq!(sends.len(), 3);
        assert_eq!(counts.len(), 3);
        assert_image(wire, &sends[0]);
        assert_image(wire, &sends[2]);
        if wire == "gemini" {
            assert_eq!(
                counts[2]["generateContentRequest"]["contents"],
                sends[2]["contents"]
            );
        } else {
            assert_eq!(counts[2]["messages"], sends[2]["messages"]);
        }
    }
}
#[test]
fn saved_attachment_text_never_grants_the_write_requested_by_a_model() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"forbidden.txt","content":"never"}),
        ),
        reply_text("Write was denied."),
    ]);
    let f = Fixture::new(&server);
    let original = seed(&f, PNG);
    let store = PolicyStore::new(f.root.path());
    let p = store.read_existing("w").unwrap();
    store
        .update_existing(
            "w",
            p.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!f.root.path().join("workspace/forbidden.txt").exists());
    let h = f.history();
    assert_eq!(h.iter().find(|m| m["id"] == "input-c").unwrap(), &original);
    let tool = h.iter().find(|m| m["segments"].is_array()).unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], false);
    assert_eq!(tool["segments"][0]["result"]["status"], "denied");
}

#[test]
fn saved_image_payload_above_the_permission_json_budget_still_obeys_the_model_request_budget() {
    let server = Server::new(vec![reply_text(
        "Large saved user payload was transported.",
    )]);
    let f = Fixture::new(&server);
    let store = peer_store::ConversationStore::new(f.root.path());
    for i in 0..2 {
        let h = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
        // Opaque user-upload bytes; this test proves transport, not raster decoding.
        let row = json!({"id":format!("large-image-{i}"),"role":"user","content":"saved user image","attachments":[{"kind":"image","dataUrl":format!("data:image/png;base64,{}","AAAA".repeat(150000))}]});
        store.commit_message(&h, &row, AT, None).unwrap();
    }
    let before = f.history();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let bytes = server.request_bytes.lock().unwrap();
    assert_eq!(bytes.len(), 1);
    assert!(bytes[0].len() > 1048576 && bytes[0].len() < 2097152);
    let after = f.history();
    for row in before {
        assert_eq!(after.iter().find(|m| m["id"] == row["id"]).unwrap(), &row);
    }
}
