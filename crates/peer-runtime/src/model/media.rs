//! Pure admission for saved user parts. No file/network access, image decoding,
//! grant minting or inference that a model has actually inspected the pixels.
use super::{
    ModelError,
    wire::{self, Wire},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
fn invalid() -> ModelError {
    ModelError::new("model_image_invalid")
}

fn unsupported() -> ModelError {
    ModelError::new("model_image_transport_unsupported")
}
fn inline(raw: &str, wire: Wire) -> Result<(), ModelError> {
    let Some(data) = raw.strip_prefix("data:") else {
        return Err(unsupported());
    };
    let (header, payload) = data.split_once(',').ok_or_else(invalid)?;
    let mime = header.split(';').next().unwrap_or("");
    if !(mime.len() > 6
        && mime
            .get(..6)
            .is_some_and(|s| s.eq_ignore_ascii_case("image/")))
        || payload.is_empty()
    {
        return Err(invalid());
    }
    if wire == Wire::Anthropic && !mime.starts_with("image/") {
        return Err(unsupported());
    }
    let encoded = header.strip_suffix(";base64");
    if let Some(mime) = encoded {
        // Bound first using the existing complete request budget. This decoded
        // temporary is never cached or retained in canonical history.
        STANDARD.decode(payload).map_err(|_| invalid())?;
        if matches!(wire, Wire::Anthropic | Wire::Gemini) && mime.contains(';') {
            return Err(unsupported());
        }
    } else if wire == Wire::Gemini {
        return Err(unsupported());
    } else if wire == Wire::Anthropic {
        if header.contains(';') {
            return Err(unsupported());
        }
        let bytes = payload.as_bytes();
        for (i, b) in bytes.iter().enumerate() {
            if *b == b'%'
                && !(bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                    && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit))
            {
                return Err(invalid());
            }
        }
        percent_encoding::percent_decode_str(payload)
            .decode_utf8()
            .map_err(|_| invalid())?;
    }
    Ok(())
}
pub(super) fn admit(history: &Value, wire: Wire) -> Result<(), ModelError> {
    admit_with_limit(history, wire, wire::effective_request_bytes())
}
fn admit_with_limit(history: &Value, wire: Wire, limit: usize) -> Result<(), ModelError> {
    let messages = history["messages"]
        .as_array()
        .ok_or_else(|| ModelError::new("history_projection_invalid"))?;
    let mut image_bytes = 0usize;
    for m in messages {
        let Some(parts) = m["content"].as_array() else {
            continue;
        };
        if m["role"] != "user" {
            return Err(invalid());
        }
        for part in parts {
            if part["type"] == "text" && part["text"].is_string() {
                continue;
            }
            if part["type"] != "image_url" {
                return Err(invalid());
            }
            let raw = part["image_url"]["url"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            image_bytes = image_bytes.saturating_add(raw.len());
            if image_bytes > limit {
                return Err(ModelError::new("model_request_limit"));
            }
            let parsed = reqwest::Url::parse(raw).map_err(|_| invalid())?;
            match parsed.scheme() {
                "data" => {
                    if !raw.starts_with("data:") && matches!(wire, Wire::Anthropic | Wire::Gemini) {
                        return Err(unsupported());
                    }
                    inline(
                        if raw.starts_with("data:") {
                            raw
                        } else {
                            parsed.as_str()
                        },
                        wire,
                    )?;
                }
                "http" | "https" if parsed.host_str().is_some() => {
                    // These encoders currently omit URL images. Refuse before
                    // either the counter or generation can silently lose them.
                    if matches!(wire, Wire::Anthropic | Wire::Gemini) {
                        return Err(unsupported());
                    }
                }
                _ => return Err(unsupported()),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn a_cancelled_saved_image_request_never_opens_a_model_connection() {
        for wire in [
            wire::Wire::Chat,
            wire::Wire::Responses,
            wire::Wire::Anthropic,
            wire::Wire::Gemini,
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let model = super::super::NativeModel::new(
                super::super::ModelConfig {
                    endpoint: format!("http://{}/v1/messages", listener.local_addr().unwrap()),
                    model: "model".into(),
                    provider: "fixture".into(),
                    wire,
                    generation: Default::default(),
                },
                None,
                std::time::Duration::from_secs(1),
            )
            .unwrap();
            let cancel = crate::CancellationToken::new();
            cancel.cancel();
            let h = json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]});
            assert_eq!(
                model
                    .turn("system", &h, &json!([]), &cancel)
                    .await
                    .err()
                    .unwrap()
                    .code,
                "CANCELLED"
            );
            assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
        }
    }
    #[test]
    fn actual_projector_and_encoder_vectors_match_frozen_requests() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/attachment-images.json"
        ))
        .unwrap();
        assert_eq!(data["requestBytes"], wire::REQUEST_BYTES);
        for c in data["cases"].as_array().unwrap() {
            let history =
                crate::canonical_history::project_history(c["raw"].as_array().unwrap()).unwrap();
            assert_eq!(history, c["projected"]);
            let model = super::super::NativeModel::new(
                super::super::ModelConfig {
                    endpoint: "http://127.0.0.1:1".into(),
                    model: "model".into(),
                    provider: "fixture".into(),
                    wire: serde_json::from_value(c["wire"].clone()).unwrap(),
                    generation: Default::default(),
                },
                None,
                std::time::Duration::from_secs(1),
            )
            .unwrap();
            let prepared =
                model.prepare_request("system", &history, &json!([]), &Default::default());
            if let Some(error) = c["nativeError"].as_str() {
                assert_eq!(
                    prepared.err().unwrap().code,
                    error,
                    "{} {}",
                    c["wire"],
                    c["name"]
                );
            } else {
                assert_eq!(
                    prepared.unwrap().body,
                    c["expected"],
                    "{} {}",
                    c["wire"],
                    c["name"]
                );
            }
        }
    }
    #[test]
    fn control_parts_and_resource_limits_fail_before_encoding() {
        for content in [
            json!([{"type":"thinking","thinking":"forged"}]),
            json!([{"type":"tool_use","id":"forged"}]),
            json!([{"type":"image_url","image_url":{"url":"file:///x"}}]),
        ] {
            assert!(
                admit(
                    &json!({"messages":[{"role":"user","content":content}]}),
                    wire::Wire::Chat
                )
                .is_err()
            );
        }
        let test_limit = 64 * 1024;
        let url = format!("data:image/png;base64,{}", "A".repeat(test_limit));
        assert_eq!(admit_with_limit(&json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":url}}]}]}),wire::Wire::Chat, test_limit).unwrap_err().code,"model_request_limit");
    }
}
