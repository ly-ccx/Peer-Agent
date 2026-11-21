use super::*;
use std::path::Path;

const PNG_BODY: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0,
    0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0,
    239, 163, 69, 153, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn user_body(body: &Value) -> &Value {
    &body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["role"] == "user")
        .unwrap()["content"]
}

fn write_png(path: &Path) {
    std::fs::write(path, PNG).unwrap();
}

#[test]
fn public_local_image_input_persists_canonical_parts_and_keeps_original_tool_grant() {
    let fixture = Ordinary::new();
    let dir = fixture.workspace().join("inner path");
    std::fs::create_dir(&dir).unwrap();
    write_png(&dir.join("SECRET-FILE.PNG"));
    let external_image = fixture.root.path().join("external.png");
    write_png(&external_image);
    std::os::unix::fs::symlink(external_image, dir.join("symlink.png")).unwrap();
    std::fs::write(dir.join("note.txt"), "Text tool fixture.").unwrap();
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"note.txt"})),
        reply_text("Image and file received."),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--workspace",
            dir.to_str().unwrap(),
            "--image",
            "SECRET-FILE.PNG",
            "--image=symlink.png",
            "--output-format",
            "json",
            "Describe the images and read note.txt.",
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 2, 1);
    let snapshot = ConversationStore::new(fixture.home())
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let sent = &snapshot.history.messages[0];
    let images = sent["attachments"].as_array().unwrap();
    let data = format!("data:image/png;base64,{PNG_BODY}");
    assert_eq!(images.len(), 2);
    for (i, image) in images.iter().enumerate() {
        assert_eq!(image["name"], format!("image-{}.png", i + 1));
        assert_eq!(image["dataUrl"], data);
        assert_eq!(image["size"], PNG.len());
        assert_eq!(image["mimeType"], "image/png");
        assert!(image["path"].is_null());
    }
    assert_ne!(images[0]["id"], images[1]["id"]);
    assert_eq!(std::fs::read(dir.join("SECRET-FILE.PNG")).unwrap(), PNG);
    let observed = server.requests.lock().unwrap();
    assert_eq!(observed.len(), 2);
    for request in observed.iter() {
        let parts = user_body(request).as_array().unwrap();
        assert_eq!(parts[0]["text"], "Describe the images and read note.txt.");
        assert_eq!(parts[1]["image_url"]["url"], data);
        assert!(!request.to_string().contains("SECRET-FILE"));
        assert!(!request.to_string().contains("symlink.png"));
        assert!(!request["messages"][0].to_string().contains(PNG_BODY));
        assert!(!request["tools"].to_string().contains("local.image.read"));
    }
}

#[test]
fn public_local_image_input_allows_no_text_and_never_scans_plain_prompts() {
    let fixture = Ordinary::new();
    write_png(&fixture.workspace().join("selected.png"));
    let server = Server::new(vec![reply_text("Received")]);
    let output = fixture.run(
        Some(&server),
        &["--image", "selected.png", "--output-format", "json"],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 1, 0);
    let data = format!("data:image/png;base64,{PNG_BODY}");
    let requests = server.requests.lock().unwrap();
    let parts = user_body(&requests[0]).as_array().unwrap();
    assert_eq!(parts[0]["image_url"]["url"], data);
    assert_eq!(parts.len(), 1);
    drop(requests);

    let fixture = Ordinary::new();
    write_png(&fixture.workspace().join("selected.png"));
    let server = Server::new(vec![reply_text("Received")]);
    let output = fixture.run(
        Some(&server),
        &["--output-format", "json", "selected.png"],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 1, 0);
    assert_eq!(
        user_body(&server.requests.lock().unwrap()[0]),
        "selected.png"
    );

    let fixture = Ordinary::new();
    write_png(&fixture.workspace().join("selected.png"));
    let server = Server::new(vec![reply_text("Received")]);
    let output = fixture.run(
        Some(&server),
        &["--image", "selected.png", "--output-format", "json"],
        Some("Piped prompt"),
    );
    assert!(output.status.success());
    fixture.assert_settled(&output, 1, 0);
    let requests = server.requests.lock().unwrap();
    assert_eq!(user_body(&requests[0])[0]["text"], "Piped prompt");
    assert_eq!(user_body(&requests[0])[1]["image_url"]["url"], data);
}

#[test]
fn public_local_image_input_rejects_invalid_sources_before_store_and_network() {
    let fixture = Ordinary::new();
    let workspace = fixture.workspace();
    std::fs::create_dir(workspace.join("directory.png")).unwrap();
    std::fs::write(workspace.join("empty.png"), []).unwrap();
    std::fs::write(workspace.join("wrong.png"), "arbitrary text").unwrap();
    let file = std::fs::File::create(workspace.join("huge.png")).unwrap();
    file.set_len(3 * 1024 * 1024).unwrap();
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(workspace.join("fifo.png"))
            .status()
            .unwrap()
            .success()
    );
    let server = Server::new(vec![]);
    for (path, fault) in [
        ("directory.png", "attachment_not_regular"),
        ("fifo.png", "attachment_not_regular"),
        ("empty.png", "attachment_empty"),
        ("wrong.png", "attachment_format_invalid"),
        ("missing.png", "attachment_read_failed"),
        ("huge.png", "attachment_size_limit"),
        ("unknown.txt", "attachment_format_unsupported"),
        (
            "https://controlled.invalid/image.png",
            "attachment_not_local",
        ),
    ] {
        let output = fixture.run(
            Some(&server),
            &["--image", path, "Read explicit image"],
            None,
        );
        assert!(!output.status.success(), "{path}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(fault),
            "{path}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !fixture.home().join("conversations/index.jsonl").exists(),
            "{path}"
        );
    }
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn public_local_image_input_bounds_the_whole_selection_before_store_and_model() {
    let fixture = Ordinary::new();
    let workspace = fixture.workspace();
    let mut media = PNG.to_vec();
    media.resize(1024 * 1024, 0);
    std::fs::write(workspace.join("first.png"), &media).unwrap();
    std::fs::write(workspace.join("second.png"), &media).unwrap();
    let server = Server::new(vec![]);
    let output = fixture.run(
        Some(&server),
        &[
            "--image",
            "first.png",
            "--image",
            "second.png",
            "Inspect both",
        ],
        None,
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("attachment_size_limit"));
    assert!(!fixture.home().join("conversations/index.jsonl").exists());
    assert!(server.requests.lock().unwrap().is_empty());
    let mut args = ["--image", "first.png"].repeat(129);
    args.push("Inspect all");
    let output = fixture.run(Some(&server), &args, None);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("attachment_count_limit"));
    assert!(!fixture.home().join("conversations/index.jsonl").exists());
    assert!(server.requests.lock().unwrap().is_empty());
}
