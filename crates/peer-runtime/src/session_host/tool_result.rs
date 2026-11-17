//! Canonical content publication happens after the real effect and before its
//! Tool Result commit. Failure leaves the original dispatch pending for recovery.
use super::{HostError, NativeSessionHost};
use crate::{CancellationToken, providers::ToolOutputKind};
use peer_store::ToolArtifactStore;
use serde_json::{Value, json};
use std::path::Path;
const INLINE: usize = 6000;
const PREVIEW: usize = 1200;
fn preview(text: &str) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= PREVIEW
        })
        .collect()
}
fn archive(
    home: &Path,
    conversation: &str,
    mut result: Value,
    kind: ToolOutputKind,
    cancel: &CancellationToken,
) -> Result<Value, HostError> {
    let output = &result["output"];
    // Provider output is already bounded at its seam. This temporary encoding is
    // bounded by that result; it is never retained as a second history cache.
    let encoded = serde_json::to_string(output).map_err(|_| HostError("artifact_invalid"))?;
    if encoded.encode_utf16().count() <= INLINE {
        return Ok(result);
    }
    let store = ToolArtifactStore::new(home);
    let is_file = kind == ToolOutputKind::FileRead && output["content"].is_string();
    let (reference, mut replacement) = if is_file {
        let content = output["content"].as_str().unwrap();
        let r = store
            .publish_utf8(conversation, content, &|| cancel.is_cancelled())
            .map_err(|e| HostError(e.code()))?;
        let mut v = json!({"kind":"local_file_ref","tool":"read_file","path":output["path"],"chars":content.encode_utf16().count(),"bytes":output["bytes"],"contentHash":output["contentHash"],"preview":preview(content),"truncated":content.encode_utf16().count()>PREVIEW});
        for name in ["start_line", "end_line", "total_lines"] {
            if let Some(value) = output.get(name) {
                v[name] = value.clone();
            }
        }
        (r, v)
    } else {
        let r = store
            .publish_json(conversation, output, &|| cancel.is_cancelled())
            .map_err(|e| HostError(e.code()))?;
        (
            r,
            json!({"kind":"local_tool_result_ref","chars":encoded.encode_utf16().count(),"preview":preview(&encoded),"truncated":true}),
        )
    };
    replacement["nativeContentRef"] =
        serde_json::to_value(&reference).map_err(|_| HostError("artifact_invalid"))?;
    replacement["retrieval"] = json!({"tool":"read_tool_result","arguments":{"reference":reference,"offset":0,"length":4096},"note":"Immutable saved observation. Check truncation/range flags and use this reader for full content; never rerun the original tool to recover historical content."});
    result["output"] = replacement;
    Ok(result)
}
impl NativeSessionHost {
    pub(super) async fn archive_tool_result(
        &mut self,
        conversation: &str,
        result: Value,
        kind: ToolOutputKind,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<Value, HostError> {
        let home = self.home.clone();
        let conversation = conversation.to_owned();
        let cancel = owned.clone();
        let task = tokio::task::spawn_blocking(move || {
            archive(&home, &conversation, result, kind, &cancel)
        });
        self.wait_owned(task, owned, external)
            .await?
            .map_err(|_| HostError("artifact_unavailable"))?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_never_splits_a_scalar_or_exceeds_utf16_budget() {
        let s = format!("{}🦀tail", "a".repeat(1199));
        let p = preview(&s);
        assert_eq!(p, "a".repeat(1199));
        assert_eq!(preview("small"), "small");
    }
}

#[cfg(test)]
mod provider_kind_tests {
    use super::*;
    #[test]
    fn structured_provider_output_cannot_impersonate_file_encoding_or_lose_extra_facts() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("conversations")).unwrap();
        std::fs::write(root.path().join("conversations/c.jsonl"), "{}").unwrap();
        let output = json!({"path":"alleged-file","content":"mcp fact".repeat(2000),"bytes":16000,"contentHash":"provider-asserted","extra":{"must":"retain complete original structured output"}});
        let result = archive(
            root.path(),
            "c",
            json!({"status":"success","output":output}),
            ToolOutputKind::Structured,
            &CancellationToken::new(),
        )
        .unwrap();
        let reference: peer_store::ToolArtifactRef =
            serde_json::from_value(result["output"]["nativeContentRef"].clone()).unwrap();
        assert_eq!(reference.format, peer_store::ToolArtifactFormat::Json);
        let window = ToolArtifactStore::new(root.path())
            .read_window("c", &reference, 0, 262144, &|| false)
            .unwrap();
        assert!(window.complete);
        assert_eq!(
            serde_json::from_slice::<Value>(&window.bytes).unwrap(),
            output
        );
    }
}
