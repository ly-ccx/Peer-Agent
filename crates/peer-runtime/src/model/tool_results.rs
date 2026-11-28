//! Request-local views of saved observations. These do not alter canonical
//! messages, grant permission, register Evidence, or execute/replay tools.
use super::ModelError;
use crate::{
    CancellationToken,
    tool_result_content::{ArchivePolicy, ToolOutputKind, archive},
};
use peer_protocol::{javascript_json_string, javascript_trim};
use serde_json::{Value, json};
use std::path::Path;
const SOURCE_AND_VIEW: usize = 16 * 1024 * 1024;
const VIEW_BYTES: usize = 64 * 1024;
const INLINE: usize = 6000;
const SHELL_PREVIEW: usize = 4000;
struct Entry {
    id: Value,
    name: Value,
    original: String,
    encoded: String,
}
pub(crate) struct ToolResultEncoding {
    entries: Vec<Entry>,
}
fn error(code: &'static str) -> ModelError {
    ModelError::new(code)
}
fn serialized(value: &Value) -> Result<String, ModelError> {
    javascript_json_string(value).map_err(|_| error("model_tool_result_encoding_limit"))
}
fn record(value: &Value) -> Option<Value> {
    if value.is_object() {
        Some(value.clone())
    } else {
        let s = value.as_str().map(javascript_trim)?;
        if !s.starts_with('{') {
            return None;
        }
        super::decode(s.as_bytes(), 1024 * 1024)
            .ok()
            .filter(Value::is_object)
    }
}
fn local_ref(value: &Value) -> bool {
    matches!(
        value["kind"].as_str(),
        Some("local_file_ref" | "local_tool_result_ref" | "local_capability_result_ref")
    )
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64() != Some(0.0),
        _ => true,
    }
}
fn first<'a>(values: impl IntoIterator<Item = &'a Value>) -> Option<&'a str> {
    values
        .into_iter()
        .filter_map(Value::as_str)
        .find(|s| !javascript_trim(s).is_empty())
}
fn quote(path: &str) -> String {
    let mut out = String::from("\"");
    for c in path.chars() {
        if matches!(c, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}
fn clip(text: &str, max: usize) -> (String, bool) {
    let total = text.encode_utf16().count();
    let mut n = 0;
    let out = text
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= max
        })
        .collect();
    (out, total > max)
}
fn append_refs(refs: &mut Vec<String>, value: &Value) {
    let values = if value.is_array() {
        value.as_array().unwrap().as_slice()
    } else {
        std::slice::from_ref(value)
    };
    for v in values {
        if let Some(s) = v.as_str().map(javascript_trim).filter(|s| !s.is_empty())
            && !refs.iter().any(|v| v == s)
        {
            refs.push(s.into());
        }
    }
}
fn evidence_refs(result: &Value) -> Vec<String> {
    let mut refs = vec![];
    if let Some(id) = result["toolCallId"]
        .as_str()
        .map(javascript_trim)
        .filter(|s| !s.is_empty())
    {
        refs.push(format!("tool-result://{id}"));
    }
    for v in [
        &result["evidence"]["refs"],
        &result["evidence"]["artifactRefs"],
        &result["outputPreview"]["artifactRef"],
        &result["outputPreview"]["artifactRefs"],
        &result["outputPreview"]["localToolResultRef"]["artifactRef"],
        &result["outputPreview"]["localToolResultRef"]["artifactRefs"],
    ] {
        append_refs(&mut refs, v);
    }
    refs
}
fn is_file(result: &Value, name: &Value, output: &Value) -> bool {
    let trusted = result["capabilityId"] == "local.file.read"
        || result.get("capabilityId").is_none()
            && matches!(name.as_str(), Some("read_file" | "local.file.read"));
    trusted
        && output["path"]
            .as_str()
            .is_some_and(|p| !javascript_trim(p).is_empty())
        && output["content"].is_string()
        && (output["bytes"].is_number() || output["contentHash"].is_string())
}
fn is_shell(output: &Value) -> bool {
    output["stdout"].is_string()
        && (output["artifactRef"].is_string()
            || output["taskId"].is_string()
            || output["command"].is_string())
}
fn trusted_shell(result: &Value, name: &Value) -> bool {
    result["capabilityId"] == "local.shell.exec"
        || result.get("capabilityId").is_none()
            && matches!(name.as_str(), Some("bash" | "local.shell.exec"))
}
fn shell_output(output: &Value, preview: &Value, refs: &[String]) -> Value {
    let full = output["stdout"].as_str().unwrap_or("");
    let source = if preview["stdout"].is_string() {
        preview
    } else {
        output
    };
    let (stdout, _) = clip(source["stdout"].as_str().unwrap_or(""), SHELL_PREVIEW);
    let path = first([&output["stdoutPath"], &preview["stdoutPath"]]);
    let artifact = first([&output["artifactRef"], &preview["artifactRef"]]);
    let mut artifacts = vec![];
    for v in [&output["artifactRefs"], &preview["artifactRefs"]] {
        for s in v
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|s| !javascript_trim(s).is_empty())
        {
            if !artifacts.iter().any(|v| v == s) {
                artifacts.push(s.to_owned());
            }
        }
    }
    let truncated = full.encode_utf16().count() > SHELL_PREVIEW
        || source["truncated"] == true
        || preview["contextPreviewTruncated"] == true;
    let exit = output
        .get("exitCode")
        .filter(|v| !v.is_null())
        .or_else(|| preview.get("exitCode"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut out = json!({"kind":"local_tool_result_ref","tool":"bash","command":first([&output["command"],&preview["command"]]),"cwd":first([&output["cwd"],&preview["cwd"]]),"exitCode":exit,"status":first([&output["status"],&preview["status"]]).unwrap_or("completed"),"artifactRef":artifact});
    if !artifacts.is_empty() {
        out["artifactRefs"] = json!(artifacts);
    }
    if let Some(path) = path {
        out["stdoutPath"] = json!(path);
    }
    if !full.is_empty() {
        out["stdoutChars"] = json!(full.encode_utf16().count());
    }
    out["stdoutPreview"] = json!(stdout);
    out["contextPreviewTruncated"] = json!(truncated);
    if let Some(path) = path {
        out["suggestedRetrieval"] = json!([
            format!("rg -n \"FAIL|Error|error|failed\" {}", quote(path)),
            format!("tail -n 120 {}", quote(path))
        ]);
    }
    out["note"] = json!(if truncated {
        "Stdout preview only. Full stream is on the shell artifact (artifactRefs / stdoutPath). Do not read ~/.peer-agent/artifacts/**/tool-tui-tool-*.txt. To reread a source file, use read_file on the workspace path."
    } else {
        "Do not recover this output by reading Peer internal tool-tui-tool artifacts."
    });
    if !refs.is_empty() {
        out["evidenceRefs"] = json!(refs);
    }
    if let Some(stderr) = output["stderr"]
        .as_str()
        .or_else(|| preview["stderr"].as_str())
        .filter(|s| !s.is_empty())
    {
        let (text, truncated) = clip(stderr, SHELL_PREVIEW);
        out["stderrPreview"] = json!(text);
        out["stderrChars"] = json!(stderr.encode_utf16().count());
        out["stderrPreviewTruncated"] = json!(truncated);
    }
    out
}
fn view(result: &Value, name: &Value) -> Result<Value, ModelError> {
    let output = record(&result["output"]).unwrap_or(Value::Null);
    let preview = record(&result["outputPreview"]).unwrap_or(Value::Null);
    let refs = evidence_refs(result);
    let mut out = if local_ref(&output) {
        output
    } else if local_ref(&preview) {
        preview
    } else if is_file(result, name, &output) {
        let content = output["content"].as_str().unwrap();
        let (preview, truncated) = clip(content, 32000);
        let mut v = json!({"kind":"local_file_ref","tool":"read_file","path":output["path"],"chars":content.encode_utf16().count()});
        if output["bytes"].is_number() {
            v["bytes"] = output["bytes"].clone();
        }
        if output["contentHash"].is_string() {
            v["contentHash"] = output["contentHash"].clone();
        }
        v["preview"] = json!(preview);
        v["contextPreviewTruncated"] = json!(truncated);
        v["suggestedRetrieval"] = json!([format!(
            "sed -n '1,160p' {}",
            quote(output["path"].as_str().unwrap())
        )]);
        v["note"] = json!(if truncated {
            "Preview only. Use read_file or sed on the workspace path for the omitted middle. Do not read Peer internal tool-tui-tool artifacts."
        } else {
            "Full file is inline. Do not recover this by reading Peer internal artifacts."
        });
        if output.get("start_line").is_some() || output.get("end_line").is_some() {
            for key in ["start_line", "end_line", "total_lines"] {
                if let Some(value) = output.get(key) {
                    v[key] = value.clone();
                }
            }
            v["ranged"] = json!(true);
            v["note"] = json!(
                "Full requested range is inline. Other file lines were not part of this observation."
            );
        }
        if !refs.is_empty() {
            v["evidenceRefs"] = json!(refs);
        }
        v
    } else if trusted_shell(result, name) && (is_shell(&output) || is_shell(&preview)) {
        shell_output(&output, &preview, &refs)
    } else {
        let mut v = json!({});
        if truthy(&result["status"]) {
            v["status"] = result["status"].clone();
        }
        if let Some(o) = result.get("output") {
            v["output"] = o.clone();
        } else if let Some(p) = result.get("outputPreview") {
            v["outputPreview"] = p.clone();
        }
        if let Some(e) = result.get("error") {
            v["error"] = e.clone();
        }
        if output.get("start_line").is_some() || output.get("end_line").is_some() {
            for key in ["start_line", "end_line", "total_lines"] {
                if let Some(value) = output.get(key) {
                    v[key] = value.clone();
                }
            }
            v["ranged"] = json!(true);
            v["note"] = json!(
                "Full requested range is inline. Other file lines were not part of this observation."
            );
        }
        if !refs.is_empty() {
            v["evidenceRefs"] = json!(refs);
        }
        v
    };
    if local_ref(&out)
        && (matches!(result["status"].as_str(),Some(s) if s!="success"&&s!="completed"&& !s.is_empty())
            || result.get("error").is_some_and(|e| !e.is_null()))
    {
        out["resultStatus"] = result["status"].clone();
        if let Some(e) = result.get("error") {
            out["resultError"] = e.clone();
        }
    }
    Ok(out)
}
fn result_object(raw: &str) -> Option<Value> {
    let value = super::decode(javascript_trim(raw).as_bytes(), 1024 * 1024).ok()?;
    let known = matches!(
        value["status"].as_str(),
        Some("success" | "completed" | "failed" | "denied" | "cancelled" | "unknown")
    );
    (value.is_object()
        && (known || value["toolCallId"].is_string())
        && ["output", "outputPreview", "error"]
            .iter()
            .any(|k| value.get(*k).is_some()))
    .then_some(value)
}

fn needs_snapshot(result: &Value, name: &Value) -> Result<bool, ModelError> {
    let o = record(&result["output"]).unwrap_or(Value::Null);
    let p = record(&result["outputPreview"]).unwrap_or(Value::Null);
    if local_ref(&o) || local_ref(&p) {
        return Ok(serialized(&view(result, name)?)?.len() > VIEW_BYTES);
    }
    let raw = result
        .get("output")
        .or_else(|| result.get("outputPreview"))
        .map(serialized)
        .transpose()?
        .unwrap_or_default();
    let shell = trusted_shell(result, name) && (is_shell(&o) || is_shell(&p));
    Ok(raw.encode_utf16().count() > INLINE
        || shell
            && [&o["stdout"], &o["stderr"], &p["stdout"], &p["stderr"]]
                .iter()
                .filter_map(|v| v.as_str())
                .any(|s| s.encode_utf16().count() > SHELL_PREVIEW))
}
impl ToolResultEncoding {
    pub fn collect(history: &Value) -> Result<Self, ModelError> {
        let mut entries = vec![];
        let mut bytes = 0usize;
        for m in history["messages"]
            .as_array()
            .ok_or_else(|| error("history_projection_invalid"))?
        {
            if m["role"] != "tool" {
                continue;
            }
            let Some(raw) = m["content"].as_str() else {
                continue;
            };
            bytes = bytes.saturating_add(raw.len());
            if bytes > SOURCE_AND_VIEW {
                return Err(error("model_tool_result_encoding_limit"));
            }
            entries.push(Entry {
                id: m["toolCallId"].clone(),
                name: m["name"].clone(),
                original: raw.into(),
                encoded: String::new(),
            });
        }
        Ok(Self { entries })
    }
    pub fn inline(self) -> Result<Self, ModelError> {
        self.encode(None, &CancellationToken::new())
    }
    pub fn materialize(
        self,
        home: &Path,
        conversation: &str,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        self.encode(Some((home, conversation)), cancel)
    }
    fn encode(
        mut self,
        sink: Option<(&Path, &str)>,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        let mut bytes = 0usize;
        for e in &mut self.entries {
            if cancel.is_cancelled() {
                return Err(error("CANCELLED"));
            }
            let parsed = result_object(&e.original);
            let needs = match &parsed {
                Some(r) => needs_snapshot(r, &e.name)?,
                None => e.original.encode_utf16().count() > INLINE,
            };
            let value = if needs {
                let (home, conversation) =
                    sink.ok_or_else(|| error("model_tool_result_materialization_required"))?;
                let mut result = parsed.unwrap_or_else(|| json!({"output":e.original}));
                let preview_only =
                    result.get("output").is_none() && result.get("outputPreview").is_some();
                if preview_only {
                    result["output"] = result["outputPreview"].clone();
                }
                let mut kind = ToolOutputKind::Structured;
                if let Some(output) = record(&result["output"])
                    && is_file(&result, &e.name, &output)
                {
                    kind = ToolOutputKind::FileRead;
                    result["output"] = output;
                }
                let result = archive(
                    home,
                    conversation,
                    result,
                    kind,
                    ArchivePolicy::Required,
                    cancel,
                )
                .map_err(|c| error(if c == "cancelled" { "CANCELLED" } else { c }))?;
                let mut encoded = view(&result, &e.name)?;
                if preview_only {
                    encoded["sourceKind"] = json!("outputPreview");
                    encoded["originalOutputAvailable"] = json!(false);
                    if result["outputPreview"]["truncated"] == true
                        || result["outputPreview"]["contextPreviewTruncated"] == true
                    {
                        encoded["sourceTruncated"] = json!(true);
                    }
                }
                Some(encoded)
            } else {
                parsed.map(|r| view(&r, &e.name)).transpose()?
            };
            e.encoded = if let Some(v) = value {
                serialized(&v)?
            } else {
                e.original.clone()
            };
            bytes = bytes
                .saturating_add(e.original.len())
                .saturating_add(e.encoded.len());
            if e.encoded.len() > VIEW_BYTES || bytes > SOURCE_AND_VIEW {
                return Err(error("model_tool_result_encoding_limit"));
            }
        }
        Ok(self)
    }
    pub fn apply_lowered(&self, messages: &mut [Value]) -> Result<(), ModelError> {
        self.apply(messages, "tool_call_id")
    }
    pub fn apply_projected(&self, messages: &mut [Value]) -> Result<(), ModelError> {
        self.apply(messages, "toolCallId")
    }
    fn apply(&self, messages: &mut [Value], id: &str) -> Result<(), ModelError> {
        let mut entries = self.entries.iter();
        for m in messages {
            if m["role"] != "tool" || !m["content"].is_string() {
                continue;
            }
            let e = entries
                .next()
                .ok_or_else(|| error("model_tool_result_identity_changed"))?;
            if m[id] != e.id || m["name"] != e.name || m["content"] != e.original {
                return Err(error("model_tool_result_identity_changed"));
            }
            m["content"] = json!(e.encoded);
        }
        if entries.next().is_some() {
            return Err(error("model_tool_result_identity_changed"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn history(name: &str, result: &Value) -> Value {
        json!({"messages":[{"role":"assistant","content":null,"toolCalls":[{"id":"wire-call","name":name,"arguments":"{}"}]},{"role":"tool","toolCallId":"wire-call","name":name,"content":result.to_string()}]})
    }
    #[test]
    fn actual_ts_encoder_vectors_and_explicit_native_safety_deltas() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-tool-results.json"
        ))
        .unwrap();
        assert_eq!(
            data["limits"],
            json!({"sourceAndViewBytes":SOURCE_AND_VIEW,"viewBytes":VIEW_BYTES,"inlineChars":INLINE,"fileInlineChars":32000,"shellPreviewChars":SHELL_PREVIEW})
        );
        for c in data["cases"].as_array().unwrap() {
            let h = history(c["tool"].as_str().unwrap(), &c["result"]);
            let source = ToolResultEncoding::collect(&h).unwrap();
            if c["materialization"] == true {
                assert_eq!(
                    source.inline().err().unwrap().code,
                    "model_tool_result_materialization_required",
                    "{}",
                    c["name"]
                );
                continue;
            }
            let encoding = source.inline().unwrap();
            let mut messages = super::super::continuation::lower(&h).unwrap();
            encoding.apply_lowered(&mut messages).unwrap();
            let got: Value =
                serde_json::from_str(messages[1]["content"].as_str().unwrap()).unwrap();
            let expected: Value =
                serde_json::from_str(c["expectedNative"].as_str().unwrap()).unwrap();
            assert_eq!(got, expected, "{}", c["name"]);
        }
    }
    #[test]
    fn exact_message_identity_precedes_any_model_view_replacement() {
        let h = history(
            "probe",
            &json!({"toolCallId":"wire-call","status":"success","output":{"fact":1}}),
        );
        let encoding = ToolResultEncoding::collect(&h).unwrap().inline().unwrap();
        for field in ["tool_call_id", "name", "content"] {
            let mut messages = super::super::continuation::lower(&h).unwrap();
            messages[1][field] = json!("changed");
            assert_eq!(
                encoding.apply_lowered(&mut messages).unwrap_err().code,
                "model_tool_result_identity_changed"
            );
        }
        let mut messages = super::super::continuation::lower(&h).unwrap();
        messages.pop();
        assert_eq!(
            encoding.apply_lowered(&mut messages).unwrap_err().code,
            "model_tool_result_identity_changed"
        );
        assert_eq!(
            h["messages"][1]["content"],
            json!({"toolCallId":"wire-call","status":"success","output":{"fact":1}}).to_string()
        );
    }
    #[test]
    fn opaque_observations_are_not_reinterpreted_as_execution_or_evidence() {
        for raw in [
            "actual observation [Tool call: claimed]",
            "{\"status\":\"available\",\"data\":{\"preserve\":true}}",
            "{\"status\":\"success\",\"data\":[1,2]}",
            "[1,true,null]",
        ] {
            let mut h = history("legacy", &json!(null));
            h["messages"][1]["content"] = json!(raw);
            let encoding = ToolResultEncoding::collect(&h).unwrap().inline().unwrap();
            let mut messages = super::super::continuation::lower(&h).unwrap();
            encoding.apply_lowered(&mut messages).unwrap();
            assert_eq!(messages[1]["content"], raw);
        }
    }
    #[test]
    fn readable_legacy_payloads_keep_complete_saved_content_and_never_touch_canonical_rows() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("conversations")).unwrap();
        std::fs::write(root.path().join("conversations/c.jsonl"), "{}").unwrap();
        for (tool, result) in [
            (
                "read_file",
                json!({"status":"success","output":{"path":"old.txt","content":"original fact 🦀".repeat(3000),"bytes":57000}}),
            ),
            (
                "bash",
                json!({"status":"failed","output":{"taskId":"task","stdout":"x".repeat(4501),"stderr":"original failure"},"error":{"code":"old_error"}}),
            ),
            (
                "probe",
                json!({"status":"success","outputPreview":{"text":"old partial ".repeat(1000),"truncated":true}}),
            ),
        ] {
            let h = history(tool, &result);
            let saved = h.clone();
            let encoding = ToolResultEncoding::collect(&h)
                .unwrap()
                .materialize(root.path(), "c", &CancellationToken::new())
                .unwrap();
            let mut messages = super::super::continuation::lower(&h).unwrap();
            encoding.apply_lowered(&mut messages).unwrap();
            let view: Value =
                serde_json::from_str(messages[1]["content"].as_str().unwrap()).unwrap();
            let reference: peer_store::ToolArtifactRef =
                serde_json::from_value(view["nativeContentRef"].clone()).unwrap();
            let window = peer_store::ToolArtifactStore::new(root.path())
                .read_window("c", &reference, 0, 262144, &|| false)
                .unwrap();
            assert!(window.complete);
            if tool == "read_file" {
                assert_eq!(
                    std::str::from_utf8(&window.bytes).unwrap(),
                    result["output"]["content"].as_str().unwrap()
                );
            } else {
                let got: Value = serde_json::from_slice(&window.bytes).unwrap();
                assert_eq!(
                    got,
                    if tool == "probe" {
                        result["outputPreview"].clone()
                    } else {
                        result["output"].clone()
                    }
                );
            }
            if tool == "probe" {
                assert_eq!(view["sourceTruncated"], true);
                assert_eq!(view["sourceKind"], "outputPreview");
            }
            if tool == "bash" {
                assert_eq!(view["resultStatus"], "failed");
                assert_eq!(view["resultError"]["code"], "old_error");
            }
            assert_eq!(h, saved);
        }
    }
}

#[cfg(test)]
mod replay_and_pressure_tests {
    use super::super::{
        LiveHistory, ModelConfig, NativeModel,
        continuation::Continuation,
        wire::{GenerationOptions, Wire},
    };
    use super::*;
    #[test]
    fn native_model_replays_authentic_material_before_encoding_only_the_tool_view() {
        let model = NativeModel::new(
            ModelConfig {
                endpoint: "http://127.0.0.1:1".into(),
                provider: "fixture".into(),
                model: "model".into(),
                wire: Wire::Anthropic,
                generation: GenerationOptions::default(),
            },
            None,
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let result = json!({"toolCallId":"call","status":"success","output":{"path":"input.txt","content":"saved content","bytes":13}});
        let h = json!({"messages":[{"role":"assistant","content":null,"toolCalls":[{"id":"call","name":"read_file","arguments":"{}"}]},{"role":"tool","name":"read_file","toolCallId":"call","content":result.to_string()}]});
        let mut live = LiveHistory::default();
        live.remember(&h,&["call".into()],Some(Continuation{binding:model.binding.clone(),text:String::new(),wire:Wire::Anthropic,blocks:vec![json!({"type":"thinking","thinking":"synthetic thought","signature":"authentic-synthetic-signature"})]})).unwrap();
        let prepared = model
            .prepare_request("system", &h, &json!([]), &live)
            .unwrap();
        let messages = prepared.body["messages"].as_array().unwrap();
        assert_eq!(
            messages[0]["content"][0]["signature"],
            "authentic-synthetic-signature"
        );
        let tool = messages[1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["type"] == "tool_result")
            .unwrap();
        let view: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
        assert_eq!(view["kind"], "local_file_ref");
        assert_eq!(view["preview"], "saved content");
        assert_eq!(h["messages"][1]["content"], result.to_string());
        let mut changed = h.clone();
        let mut result = result;
        result["output"]["content"] = json!("changed saved fact");
        changed["messages"][1]["content"] = json!(result.to_string());
        let prepared = model
            .prepare_request("system", &changed, &json!([]), &live)
            .unwrap();
        assert!(
            !prepared.body["messages"][0]["content"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["type"] == "thinking"),
            "a new view cannot bless old authentic continuation bytes"
        );
    }
    #[test]
    fn source_and_view_pressure_are_explicit_and_cancelled_derivation_never_opens_store() {
        let rows=(0..17).map(|i|json!({"role":"tool","toolCallId":i.to_string(),"name":"legacy","content":"x".repeat(1024*1024)})).collect::<Vec<_>>();
        assert_eq!(
            ToolResultEncoding::collect(&json!({"messages":rows}))
                .err()
                .unwrap()
                .code,
            "model_tool_result_encoding_limit"
        );
        let h = json!({"messages":[{"role":"tool","toolCallId":"call","name":"probe","content":json!({"status":"failed","output":{},"error":{"message":"x".repeat(VIEW_BYTES)}}).to_string()}]});
        assert_eq!(
            ToolResultEncoding::collect(&h)
                .unwrap()
                .inline()
                .err()
                .unwrap()
                .code,
            "model_tool_result_encoding_limit"
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            ToolResultEncoding::collect(&h)
                .unwrap()
                .materialize(home.path(), "missing-conversation", &cancel)
                .err()
                .unwrap()
                .code,
            "CANCELLED"
        );
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod preview_availability_tests {
    use super::*;
    #[test]
    fn absent_full_output_does_not_invent_a_truncation_fact() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("conversations")).unwrap();
        std::fs::write(home.path().join("conversations/c.jsonl"), "{}").unwrap();
        let result = json!({"status":"success","outputPreview":{"text":"saved preview ".repeat(700),"truncated":false}});
        let h = json!({"messages":[{"role":"tool","toolCallId":"call","name":"probe","content":result.to_string()}]});
        let encoding = ToolResultEncoding::collect(&h)
            .unwrap()
            .materialize(home.path(), "c", &CancellationToken::new())
            .unwrap();
        let mut lowered = super::super::continuation::lower(&h).unwrap();
        encoding.apply_lowered(&mut lowered).unwrap();
        let view: Value = serde_json::from_str(lowered[0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(view["sourceKind"], "outputPreview");
        assert_eq!(view["originalOutputAvailable"], false);
        assert!(view.get("sourceTruncated").is_none());
    }
}
