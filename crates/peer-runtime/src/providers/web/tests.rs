use super::*;
use sha2::{Digest, Sha256};
#[test]
fn actual_legacy_extraction_vectors_preserve_content_and_explicit_truncation() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/contracts/native-cli/web-fetch-cases.json"
    ))
    .unwrap();
    for c in data["vectors"].as_array().unwrap() {
        let i = &c["input"];
        if c["legacy"]["ok"] != true && i["name"] != "bad-entity" {
            continue;
        }
        let raw = if let Some(bytes) = i["bytes"].as_array() {
            String::from_utf8_lossy(
                &bytes
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u8)
                    .collect::<Vec<_>>(),
            )
            .into_owned()
        } else if let Some(repeat) = i["repeat"].as_str() {
            format!(
                "{}{}",
                i["prefix"].as_str().unwrap_or(""),
                repeat.repeat(i["count"].as_u64().unwrap() as usize)
            )
        } else {
            i["body"].as_str().unwrap_or("").into()
        };
        let result = text::normalize(raw, i["type"].as_str().unwrap_or("text/plain"), &|| false);
        if i["name"] == "bad-entity" {
            assert_eq!(result.err().unwrap(), "web_content_invalid");
            continue;
        }
        let actual = result.unwrap();
        let e = &c["native"];
        assert_eq!(actual.title, e["title"], "{}", i["name"]);
        assert_eq!(
            actual.content.len(),
            e["contentBytes"].as_u64().unwrap() as usize
        );
        assert_eq!(
            actual.content.encode_utf16().count(),
            e["contentChars"].as_u64().unwrap() as usize
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(actual.content.as_bytes())),
            e["contentSha256"],
            "{}",
            i["name"]
        );
        assert_eq!(actual.truncated, e["contentTruncated"]);
    }
}
#[test]
fn url_and_redaction_limits_precede_request_or_unbounded_expansion() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../../packages/protocol/contracts/native-cli/web-fetch-cases.json"
    ))
    .unwrap();
    for c in data["urlCases"].as_array().unwrap() {
        let r = http::normalize(c["url"].as_str().unwrap(), None);
        if c["error"].is_string() {
            assert_eq!(r.err().unwrap(), c["error"])
        } else {
            assert_eq!(r.unwrap().as_str(), c["normalized"]);
        }
    }
    assert_eq!(
        http::normalize("https://SYNTHETIC:secret@fixture.invalid/", None).unwrap_err(),
        "web_url_credentials"
    );
    assert_eq!(
        text::protect(&"a".repeat(100), &["a".into()], 128)
            .err()
            .unwrap(),
        "web_redaction_limit"
    );
    assert_eq!(
        text::protect(
            "secret [REDACTED]",
            &["secret".into(), "REDACTED".into()],
            128
        )
        .unwrap()
        .0,
        "[REDACTED] [[REDACTED]]"
    );
    assert_eq!(
        text::normalize("<title>&#55296;</title>".into(), "text/html", &|| false)
            .err()
            .unwrap(),
        "web_content_invalid"
    );
    assert_eq!(
        text::normalize(
            format!("<title>{}</title>", "x".repeat(65537)),
            "text/html",
            &|| false
        )
        .err()
        .unwrap(),
        "web_content_limit"
    );
}
