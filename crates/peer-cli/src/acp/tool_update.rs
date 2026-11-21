//! Project the original tool intent and settled result onto ACP's presentation fields.
use serde_json::{Value, json};
use std::io::{self, Write};

// Leave headroom under the transport's 2 MiB frame limit. The result projection
// stays small even when the canonical output references a large saved artifact.
const RAW_INPUT_BYTES: usize = 1024 * 1024;
const DETAIL_BYTES: usize = 4096;

pub(super) fn pending(call_id: &str, tool: &str, arguments: &Value) -> Value {
    let mut update = json!({"toolCallId":call_id,"title":tool,"status":"pending"});
    if serde_json::to_writer(BoundedWriter::new(io::sink(), RAW_INPUT_BYTES), arguments).is_ok() {
        update["rawInput"] = arguments.clone();
    } else {
        update["content"] = content(json_detail(arguments));
        update["_meta"] = json!({"peer":{"inputTruncated":true}});
    }
    update
}

pub(super) fn settled(call_id: &str, result: &Value, evidence_ref: Option<&str>) -> Value {
    let status = result["status"].as_str().unwrap_or("failed");
    let detail = if status == "success" {
        json_detail(&result["output"])
    } else {
        result["error"]["message"]
            .as_str()
            .unwrap_or(status)
            .to_owned()
    };
    let mut update = json!({
        "sessionUpdate":"tool_call_update",
        "toolCallId":call_id,
        "status":if status == "success" { "completed" } else { "failed" },
        "content":content(detail)
    });
    if let Some(reference) = evidence_ref {
        update["_meta"] = json!({"peer":{"evidenceRef":reference}});
    }
    update
}

fn content(text: String) -> Value {
    json!([{"type":"content","content":{"type":"text","text":text}}])
}

fn json_detail(value: &Value) -> String {
    let mut bytes = Vec::new();
    let limit = DETAIL_BYTES - "…".len();
    if serde_json::to_writer_pretty(BoundedWriter::new(&mut bytes, limit), value).is_ok() {
        return String::from_utf8(bytes).expect("JSON is UTF-8");
    }
    if let Err(error) = std::str::from_utf8(&bytes) {
        bytes.truncate(error.valid_up_to());
    }
    let mut text = String::from_utf8(bytes).expect("truncated JSON prefix is UTF-8");
    text.push('…');
    text
}

struct BoundedWriter<W> {
    inner: W,
    remaining: usize,
}

impl<W> BoundedWriter<W> {
    fn new(inner: W, remaining: usize) -> Self {
        Self { inner, remaining }
    }
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self
            .inner
            .write(&bytes[..bytes.len().min(self.remaining)])?;
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_fields_keep_a_bounded_utf8_detail() {
        let arguments = json!({"content":"世".repeat(RAW_INPUT_BYTES / 3 + 1)});
        let update = pending("call", "write_file", &arguments);
        assert!(update.get("rawInput").is_none());
        assert_eq!(update["_meta"]["peer"]["inputTruncated"], true);
        let detail = update["content"][0]["content"]["text"].as_str().unwrap();
        assert!(detail.len() <= DETAIL_BYTES);
        assert!(detail.contains('世'));
        assert!(detail.ends_with('…'));

        let result = json!({"status":"success","output":arguments});
        let update = settled("call", &result, Some("tool-result://call"));
        assert_eq!(update["status"], "completed");
        assert_eq!(update["_meta"]["peer"]["evidenceRef"], "tool-result://call");
        assert_eq!(update["content"][0]["content"]["text"], detail);
    }
}
