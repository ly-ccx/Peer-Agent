use super::*;
mod shape;
#[derive(Default)]
pub(in crate::model) struct Qoder {
    frames: Frames,
    pub chat: ChatStream,
    shape: shape::Shape,
}
impl Qoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ModelError> {
        let Self {
            frames,
            chat,
            shape,
        } = self;
        frames
            .push(chunk, |bytes| {
                if bytes == b"[DONE]" {
                    return shape.terminal(chat);
                }
                let envelope = decode(bytes, 1024 * 1024)?;
                reject_business_error(&envelope)?;
                let inner = envelope["body"]
                    .as_str()
                    .map(|s| decode(s.as_bytes(), 1024 * 1024))
                    .transpose()?;
                let event = inner.as_ref().unwrap_or(&envelope);
                reject_business_error(event)?;
                shape.event(chat, event)
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
    let hint = super::super::qoder_retry::classify(event);
    if hint.is_some()
        || status.is_some_and(|n| n >= 400)
        || event["success"] == false
        || event["type"] == "error"
        || !event["error"].is_null()
        || (!event["code"].is_null()
            && !matches!(event["code"].as_str(), Some("0" | "200"))
            && event["code"] != 0
            && event["code"] != 200)
    {
        let mut error = ModelError::new(
            if matches!(hint, Some(super::super::qoder_retry::Hint::Queue { .. })) {
                "qoder_queue_wait_required"
            } else {
                "qoder_stream_rejected"
            },
        );
        error.retry = hint;
        return Err(error);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_sparse_block_lifecycles_and_limits_never_complete_a_call() {
        use serde_json::json;
        let start = json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool","name":"write_file","input":{}}});
        let delta = json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}});
        let stop = json!({"type":"content_block_stop","index":0});
        let mut changed = delta.clone();
        changed["index"] = 1.into();
        let mut excessive = start.clone();
        excessive["index"] = 128.into();
        let cases = vec![
            vec![json!({"choices":[{"delta":{"thinking":"cognition without an answer"}}]})],
            vec![json!({"choices":[null]})],
            vec![json!({"choices":[{"delta":{"tool_calls":[true]}}]})],
            vec![json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":3}]}}]})],
            vec![start.clone(), start.clone()],
            vec![changed],
            vec![excessive],
            vec![start.clone(), delta.clone(), stop.clone(), stop.clone()],
            vec![start.clone(), delta.clone(), stop.clone(), delta.clone()],
            vec![start.clone(), delta.clone()],
            vec![
                start.clone(),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"wrong block"}}),
            ],
            vec![
                start.clone(),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x".repeat(65537)}}),
            ],
            vec![json!({"choices":[{"delta":{"content":"x".repeat(512*1024+1)}}]})],
            vec![
                json!({"choices":[{"delta":{"content":"text"}}]}),
                start.clone(),
            ],
            vec![
                start,
                delta,
                stop,
                json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"}}),
            ],
        ];
        for events in cases {
            let mut bytes = events
                .iter()
                .map(|v| format!("data: {v}\n\n"))
                .collect::<String>();
            bytes.push_str("data: [DONE]\n\n");
            for width in [17, 4096] {
                let mut decoder = Qoder::default();
                let mut failed = false;
                for chunk in bytes.as_bytes().chunks(width) {
                    if decoder.push(chunk).is_err() {
                        failed = true;
                        break;
                    }
                }
                assert!(failed || decoder.finish("actual-request".into()).is_err());
            }
        }
    }
    #[test]
    fn actual_ts_qoder_stream_variants_match_before_exposing_tools() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/qoder-streams.json"
        ))
        .unwrap();
        for c in data["cases"].as_array().unwrap() {
            for width in [1, 7, 4096] {
                let mut decoder = Qoder::default();
                for chunk in c["stream"].as_str().unwrap().as_bytes().chunks(width) {
                    decoder
                        .push(chunk)
                        .unwrap_or_else(|e| panic!("{}: {}", c["name"], e.code));
                }
                let r = decoder
                    .finish("physical-body".into())
                    .unwrap_or_else(|e| panic!("{}: {}", c["name"], e.code));
                assert_eq!(r.content, c["expected"]["content"].as_str().unwrap());
                assert_eq!(
                    serde_json::json!(
                        r.calls
                            .iter()
                            .map(|x| serde_json::json!({"name":x.name,"arguments":x.arguments}))
                            .collect::<Vec<_>>()
                    ),
                    c["expected"]["calls"]
                );
                assert_eq!(r.usage.unwrap_or(Value::Null), c["expected"]["usage"]);
                let thought = r
                    .continuation
                    .map(|x| {
                        x.blocks[0]["reasoning_content"]
                            .as_str()
                            .unwrap()
                            .to_owned()
                    })
                    .unwrap_or_default();
                assert_eq!(thought, c["expected"]["thinking"].as_str().unwrap());
            }
        }
    }
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
