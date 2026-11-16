use super::*;
#[derive(Default)]
pub(in crate::model) struct Qoder {
    frames: Frames,
    pub chat: ChatStream,
}
impl Qoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ModelError> {
        self.frames
            .push(chunk, |bytes| {
                if bytes == b"[DONE]" {
                    self.chat.event(bytes)?;
                    return Ok(true);
                }
                let envelope = decode(bytes, 1024 * 1024)?;
                reject_business_error(&envelope)?;
                let inner = envelope["body"]
                    .as_str()
                    .map(|s| decode(s.as_bytes(), 1024 * 1024))
                    .transpose()?;
                let event = inner.as_ref().unwrap_or(&envelope);
                reject_business_error(event)?;
                let bytes = serde_json::to_vec(event)
                    .map_err(|_| ModelError::new("model_stream_invalid"))?;
                self.chat.event(&bytes)?;
                Ok(self.chat.terminal())
            })
            .map(|_| ())
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if !self.frames.complete() {
            return Err(ModelError::new("model_stream_incomplete"));
        }
        self.chat.finish(fingerprint)
    }
}
// Check both layers: an inner choices/usage object cannot cancel an outer
// rejection, and a successful transport envelope cannot hide an inner error.
fn reject_business_error(event: &Value) -> Result<(), ModelError> {
    let status = event
        .get("statusCodeValue")
        .filter(|v| !v.is_null())
        .unwrap_or(&event["status"]);
    let status = status
        .as_u64()
        .or_else(|| status.as_str().and_then(|s| s.parse().ok()));
    if status.is_some_and(|n| n >= 400) || event["success"] == false {
        return Err(ModelError::new("qoder_stream_rejected"));
    }
    if event["code"] == "10605" || event["code"] == 10605 {
        return Err(ModelError::new("qoder_queue_wait_required"));
    }
    if event["type"] == "error"
        || !event["error"].is_null()
        || (!event["code"].is_null()
            && !matches!(event["code"].as_str(), Some("0" | "200"))
            && event["code"] != 0
            && event["code"] != 200)
    {
        return Err(ModelError::new("qoder_stream_rejected"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn business_errors_and_truncated_envelopes_never_expose_partial_tools() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/model-streams.json"
        ))
        .unwrap();
        let stream = data["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["wire"] == "openai-chat" && v["kind"] == "tool")
            .unwrap()["stream"]
            .as_str()
            .unwrap();
        let complete = stream
            .split('\n')
            .map(|line| {
                if let Some(raw) = line.strip_prefix("data: ").filter(|v| *v != "[DONE]") {
                    format!("data: {}", serde_json::json!({"status":200,"body":raw}))
                } else {
                    line.into()
                }
            })
            .collect::<Vec<String>>()
            .join("\n");
        for width in [1, 7, 1024] {
            let mut decoder = Qoder::default();
            for chunk in complete.as_bytes().chunks(width) {
                decoder.push(chunk).unwrap();
            }
            assert_eq!(
                decoder.finish("actual-bytes".into()).unwrap().calls.len(),
                1
            );
        }
        let partial = complete.replace("data: [DONE]", "");
        let mut decoder = Qoder::default();
        decoder.push(partial.as_bytes()).unwrap();
        assert_eq!(
            decoder.finish("partial".into()).err().unwrap().code,
            "model_stream_incomplete"
        );
        for event in [
            serde_json::json!({"code":10605,"message":{"isQueued":true}}),
            serde_json::json!({"code":"103","message":"Duplicate request"}),
            serde_json::json!({"status":401,"body":"credential must stay private"}),
            serde_json::json!({"error":{"message":"provider rejected"}}),
        ] {
            let mut decoder = Qoder::default();
            decoder.push(partial.as_bytes()).unwrap();
            assert!(
                decoder
                    .push(format!("data: {event}\n\n").as_bytes())
                    .is_err()
            );
        }
    }
}
