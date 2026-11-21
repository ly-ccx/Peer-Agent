use super::*;
#[test]
fn both_qoder_dialects_keep_saved_image_bytes_in_real_authenticated_requests_and_tool_history() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/attachment-images.json"
    ))
    .unwrap();
    let url = data["cases"][0]["raw"][0]["attachments"][1]["dataUrl"]
        .as_str()
        .unwrap();
    for legacy in [false, true] {
        let replies = vec![
            reply_tool("read_file", json!({"path":"input.txt"})),
            reply_text("Saved image remained in context."),
        ];
        let server = Server::new(if legacy {
            replies
        } else {
            replies.into_iter().map(wrapped).collect()
        });
        let f = Fixture::new(&server);
        let credentials = configure(&f, &server);
        if legacy {
            super::legacy::select(&f, "unknown-model");
        }
        let original = super::super::native_attachments::seed(&f, url);
        let out = command(&f).output().unwrap();
        assert!(
            out.status.success(),
            "legacy={legacy}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for r in requests.iter() {
            assert!(
                r["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] == "user")
                    .flat_map(|m| m["content"].as_array().into_iter().flatten())
                    .any(|p| p["image_url"]["url"] == url)
            );
        }
        assert_eq!(
            std::fs::read(f.root.path().join(".qoder/.auth/user")).unwrap(),
            credentials
        );
        let h = f.history();
        assert_eq!(h.iter().find(|m| m["id"] == "input-c").unwrap(), &original);
        let tool = h.iter().find(|m| m["segments"].is_array()).unwrap();
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert!(tool["segments"][0]["result"]["evidence"].is_object());
        assert!(!tool.to_string().contains("iVBOR"));
    }
}
