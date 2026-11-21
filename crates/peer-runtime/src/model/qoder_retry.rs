//! Qoder retry facts and finite per-generation policy. No raw error text is
//! retained, and the Host owns waits, budget admission and each usage commit.
use super::ModelError;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hint {
    Queue {
        wait_ms: u64,
        cadence_ms: Option<u64>,
    },
    Duplicate,
    Transient,
    Connection,
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.trim().parse().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
}
fn millis(v: &Value, scale: f64) -> Option<u64> {
    number(v).map(|n| (n * scale).clamp(1.0, 9_007_199_254_740_991.0) as u64)
}
fn field<'a>(v: &'a Value, a: &str, b: &str) -> &'a Value {
    v.get(a).filter(|v| !v.is_null()).unwrap_or(&v[b])
}
fn code(v: &Value, expected: &str) -> bool {
    v.as_str() == Some(expected) || v.as_u64().is_some_and(|n| n.to_string() == expected)
}
fn transient(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "429",
        "rate limit",
        "tpm",
        "all models failed",
        "all backends failed",
        "econnreset",
        "etimedout",
        "fetch failed",
        "socket hang up",
    ]
    .iter()
    .any(|s| text.contains(s))
}
fn parsed(v: &Value) -> Option<Value> {
    let text = v.as_str()?;
    if text.len() > 65536 {
        return None;
    }
    super::decode(text.as_bytes(), 65536)
        .ok()
        .filter(Value::is_object)
}
/// Only bounded, already validated provider envelopes enter here. Nested JSON
/// messages are a real Qoder queue carrier; they never enter System Context.
pub(crate) fn classify(event: &Value) -> Option<Hint> {
    classify_inner(event, 0)
}
fn classify_inner(event: &Value, depth: usize) -> Option<Hint> {
    if depth > 3 {
        return None;
    }
    let status = field(event, "statusCodeValue", "status");
    let status = status.as_u64().or_else(|| status.as_str()?.parse().ok());
    if matches!(status, Some(401 | 403 | 407)) {
        return None;
    }
    let mut source = event.clone();
    for _ in 0..3 {
        if source["message"].is_object() {
            source = source["message"].clone();
        } else if let Some(v) = parsed(&source["message"]) {
            source = v;
        } else {
            break;
        }
    }
    if code(&event["code"], "10605")
        || code(&event["type"], "10605")
        || source["isQueued"] == true
        || source["queued"] == true
    {
        return Some(Hint::Queue {
            wait_ms: millis(field(&source, "waitTime", "wait_time"), 1000.0)
                .or_else(|| millis(&source["estimatedWaitMs"], 1.0))
                .unwrap_or(15000),
            cadence_ms: millis(
                field(&source, "retryAfterSeconds", "retry_after_seconds"),
                1000.0,
            ),
        });
    }
    for key in ["code", "error_code", "errCode", "type"] {
        if code(&event[key], "103") {
            return Some(Hint::Duplicate);
        }
    }
    if event["message"]
        .as_str()
        .is_some_and(|s| s.to_ascii_lowercase().contains("duplicate request"))
    {
        return Some(Hint::Duplicate);
    }
    for key in ["error", "body", "message"] {
        let value = &event[key];
        let nested = parsed(value);
        if let Some(hint) = (if value.is_object() {
            Some(value)
        } else {
            nested.as_ref()
        })
        .and_then(|v| classify_inner(v, depth + 1))
        {
            return Some(hint);
        }
    }
    if status == Some(429)
        || code(&event["code"], "429")
        || code(&event["type"], "429")
        || event["message"].as_str().is_some_and(transient)
        || event["error"].as_str().is_some_and(transient)
    {
        return Some(Hint::Transient);
    }
    None
}
pub(crate) fn http(status: u16, body: &[u8]) -> ModelError {
    let mut error = ModelError::http(status, body);
    if error.context_overflow_status.is_none() && !matches!(status, 401 | 403 | 407) {
        error.retry = super::decode(body, 65536)
            .ok()
            .as_ref()
            .and_then(classify)
            .or_else(|| {
                let text = std::str::from_utf8(body).unwrap_or("");
                if text.to_ascii_lowercase().contains("duplicate request") {
                    Some(Hint::Duplicate)
                } else if status == 429 || transient(text) {
                    Some(Hint::Transient)
                } else {
                    None
                }
            });
    }
    error
}
#[derive(Default)]
pub(crate) struct Policy {
    queues: u8,
    waited: u64,
    duplicates: u8,
    transients: usize,
    connections: usize,
}
impl Policy {
    pub(crate) fn next(&mut self, error: &ModelError) -> Result<Option<Duration>, ModelError> {
        let Some(mut hint) = error.retry else {
            return Ok(None);
        };
        if hint == Hint::Connection {
            if let Some(ms) = [1000, 3000].get(self.connections) {
                self.connections += 1;
                return Ok(Some(Duration::from_millis(*ms)));
            }
            hint = Hint::Transient;
        }
        self.connections = 0;
        let ms = match hint {
            Hint::Queue {
                wait_ms,
                cadence_ms,
            } => {
                let remaining = 600_000 - self.waited;
                if self.queues >= 40 || remaining < 50 {
                    return Err(ModelError::new("qoder_queue_timeout"));
                }
                let base = cadence_ms.unwrap_or(wait_ms.min(15000));
                let ms = (base + u64::from(self.queues.min(3)) * 2000)
                    .clamp(50, 60000)
                    .min(remaining);
                self.queues += 1;
                self.waited += ms;
                ms
            }
            Hint::Duplicate => {
                if self.duplicates >= 1 {
                    return Err(ModelError::new("qoder_duplicate_request"));
                }
                self.duplicates += 1;
                2000
            }
            Hint::Transient => {
                let Some(ms) = [1000, 2000, 4000].get(self.transients) else {
                    return Ok(None);
                };
                self.transients += 1;
                *ms
            }
            Hint::Connection => unreachable!(),
        };
        Ok(Some(Duration::from_millis(ms)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn error(hint: Hint) -> ModelError {
        let mut e = ModelError::new("synthetic");
        e.retry = Some(hint);
        e
    }
    #[test]
    fn actual_ts_classification_and_queue_cadence_vectors_match() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/qoder-retry.json"
        ))
        .unwrap();
        for (index, case) in data["cases"].as_array().unwrap().iter().enumerate() {
            let hint = classify(&case["event"]);
            let expected = &case["expected"];
            match hint {
                Some(Hint::Queue {
                    wait_ms,
                    cadence_ms,
                }) => {
                    assert_eq!(expected["kind"], "queue", "case {index}");
                    assert_eq!(json!(wait_ms), expected["waitMs"]);
                    assert_eq!(json!(cadence_ms), expected["cadenceMs"]);
                    for (i, attempt) in [0, 1, 2, 3, 10].into_iter().enumerate() {
                        let mut policy = Policy {
                            queues: attempt,
                            ..Policy::default()
                        };
                        assert_eq!(
                            json!(
                                policy
                                    .next(&error(hint.unwrap()))
                                    .unwrap()
                                    .unwrap()
                                    .as_millis()
                            ),
                            expected["delays"][i],
                            "case {index}"
                        );
                    }
                }
                Some(Hint::Duplicate) => assert_eq!(expected["kind"], "duplicate", "case {index}"),
                Some(Hint::Transient) => assert_eq!(expected["kind"], "transient", "case {index}"),
                None => assert!(expected.is_null(), "case {index}: {expected}"),
                _ => panic!("not a connection fact"),
            }
        }
    }
    #[test]
    fn queue_sleep_budget_and_count_are_both_enforced_without_overshoot() {
        for cadence in [1, 50000, 60000] {
            let mut policy = Policy::default();
            let mut waited = 0;
            let mut count = 0;
            while let Ok(Some(delay)) = policy.next(&error(Hint::Queue {
                wait_ms: 15000,
                cadence_ms: Some(cadence),
            })) {
                waited += delay.as_millis();
                count += 1;
                assert!(waited <= 600000);
                assert!(count <= 40);
            }
            assert!(waited == 600000 || count == 40);
        }
        let mut p = Policy {
            waited: 599980,
            ..Policy::default()
        };
        assert_eq!(
            p.next(&error(Hint::Queue {
                wait_ms: 15000,
                cadence_ms: None
            }))
            .unwrap_err()
            .code,
            "qoder_queue_timeout"
        );
    }
    #[test]
    fn connection_recovery_and_outer_transients_have_one_finite_combined_bound() {
        let mut p = Policy::default();
        let mut delays = vec![];
        while let Some(delay) = p.next(&error(Hint::Connection)).unwrap() {
            delays.push(delay.as_millis());
        }
        assert_eq!(
            delays,
            vec![
                1000, 3000, 1000, 1000, 3000, 2000, 1000, 3000, 4000, 1000, 3000
            ]
        );
        let mut p = Policy::default();
        assert_eq!(
            p.next(&error(Hint::Duplicate))
                .unwrap()
                .unwrap()
                .as_millis(),
            2000
        );
        assert_eq!(
            p.next(&error(Hint::Duplicate)).unwrap_err().code,
            "qoder_duplicate_request"
        );
        assert_eq!(p.next(&ModelError::new("CANCELLED")).unwrap(), None);
        assert_eq!(
            p.next(&ModelError::new("model_stream_incomplete")).unwrap(),
            None
        );
    }
    #[test]
    fn http_errors_keep_context_and_auth_denials_outside_retry_and_do_not_keep_private_text() {
        for status in [401, 403, 407, 413] {
            let e = http(
                status,
                br#"{"code":10605,"message":"rate limit SYNTHETIC-PRIVATE"}"#,
            );
            assert!(e.retry.is_none());
            assert!(!format!("{e:?}").contains("SYNTHETIC"));
        }
        assert_eq!(http(429, b"").retry, Some(Hint::Transient));
        assert!(
            http(400, br#"{"message":"maximum context length"}"#)
                .context_overflow_status
                .is_some()
        );
    }
}
