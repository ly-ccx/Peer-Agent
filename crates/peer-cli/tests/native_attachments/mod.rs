//! Saved user material is neither a system instruction nor a local tool grant.
use super::*;
mod transport;
const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
pub(super) fn seed(f: &Fixture, url: &str) -> Value {
    let mut row = f.history()[0].clone();
    row["attachments"] = json!([
        {"id":"text","kind":"text","name":"facts.txt","mimeType":"text/plain","size":20,"text":"Attachment text is user data."},
        {"id":"image","kind":"image","name":"pixel.png","mimeType":"image/png","size":68,"dataUrl":url},
        {"id":"opaque","kind":"unsupported","name":"opaque.bin","size":5}
    ]);
    std::fs::write(
        f.root.path().join("conversations/c.jsonl"),
        format!("{row}\n"),
    )
    .unwrap();
    row
}
#[test]
fn saved_user_image_reaches_the_public_model_request_and_tool_evidence_without_rewriting_input() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("Image and file input received."),
    ]);
    let f = Fixture::new(&server);
    let original = seed(&f, PNG);
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let content = requests[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "user")
        .unwrap()["content"]
        .as_array()
        .unwrap();
    assert_eq!(
        content.iter().find(|p| p["type"] == "image_url").unwrap()["image_url"]["url"],
        PNG
    );
    assert!(
        content[0]["text"]
            .as_str()
            .unwrap()
            .contains("Attachment text is user data.")
    );
    assert!(
        !requests[0]["messages"][0]["content"]
            .to_string()
            .contains(PNG)
    );
    let h = f.history();
    assert_eq!(h.iter().find(|m| m["id"] == "input-c").unwrap(), &original);
    let tool = h.iter().find(|m| m["segments"].is_array()).unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], true);
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
}
